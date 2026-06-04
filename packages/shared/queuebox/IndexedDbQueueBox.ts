import { Temporal } from '@js-temporal/polyfill';
import type { PersistenceSetItemOptions } from '../persistence/PersistenceProvider.ts';
import { openIndexedDbWithStore } from '../persistence/openIndexedDb.ts';
import { RateLimiter } from '../resilience/Resilience.ts';
import { ResilienceDto } from './DequeueResourceEntryController.ts';
import { QueueBoxResourceEntryRepository } from './QueueBoxTypes.ts';
import {
    COMPLETED_STATUSES,
    EntityStatus,
    FAILED_STATUS,
    Key,
    NEVER_EXPIRE_TS,
    NEW_AND_RETRY_STATUSES,
    ResourceEntry,
    ResourceEntryKeyString,
    TIMEOUT_ON_NON_RESPONSIVE_ENTRY,
    toKeyAsString,
} from './ResourceEntry.ts';

type StoredResourceEntry = Readonly<{
    keyString: ResourceEntryKeyString;
    key: Key;
    resource: string;
    typeId: string;
    audit: Readonly<{
        date: string;
        createdBy: string;
        createdTs: string;
        expiryTs?: string;
    }>;
    status: EntityStatus;
    dequeueAudit: Readonly<{
        startTs?: string;
        endTs?: string;
        nextTs?: string;
        attempts: number;
    }>;
}>;

function temporalText(value: unknown, fallback: string): string {
    if (typeof value === 'string' && value.length > 0 && value !== '[object Object]') {
        return value;
    }

    if (
        value &&
        typeof value === 'object' &&
        'toString' in value &&
        typeof value.toString === 'function'
    ) {
        const text = value.toString();
        if (text.length > 0 && text !== '[object Object]') {
            return text;
        }
    }

    return fallback;
}

function toPlainTime(value: unknown): Temporal.PlainTime {
    const fallback = Temporal.Now.plainTimeISO();
    try {
        return Temporal.PlainTime.from(temporalText(value, fallback.toString()));
    } catch {
        return fallback;
    }
}

function toPlainDateTime(value: unknown): Temporal.PlainDateTime {
    const fallback = Temporal.Now.plainDateTimeISO();
    try {
        return Temporal.PlainDateTime.from(temporalText(value, fallback.toString()));
    } catch {
        return fallback;
    }
}

function toInstant(
    value: unknown,
    fallback: Temporal.Instant = NEVER_EXPIRE_TS,
): Temporal.Instant {
    try {
        return Temporal.Instant.from(temporalText(value, fallback.toString()));
    } catch {
        return fallback;
    }
}

function toOptionalInstant(value: unknown): Temporal.Instant | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    try {
        return Temporal.Instant.from(temporalText(value, ''));
    } catch {
        return undefined;
    }
}

export type IndexedDbQueueBoxOptions = Readonly<{
    dbName?: string;
    storeName?: string;
}>;

export class IndexedDbQueueBox implements QueueBoxResourceEntryRepository {
    static readonly DEFAULT_DB_NAME = 'ar-eye-hunter-queuebox';
    static readonly DEFAULT_STORE_NAME = 'entries';

    private readonly dbName: string;
    private readonly storeName: string;
    private dbPromise?: Promise<IDBDatabase>;

    private readonly cleanupRateLimiter: RateLimiter =
        RateLimiter.init(
            ResilienceDto.RATE_LIMITER_RESERVED_TIMEOUT_SLIDING_WINDOW_DURATION_MS,
            ResilienceDto.MAX_NUM_IS_ENTRY_CHECK,
        );

    constructor(options: IndexedDbQueueBoxOptions = {}) {
        this.dbName = options.dbName ?? IndexedDbQueueBox.DEFAULT_DB_NAME;
        this.storeName = options.storeName ?? IndexedDbQueueBox.DEFAULT_STORE_NAME;
    }

    static isSupported(): boolean {
        return typeof indexedDB !== 'undefined';
    }

    cleanup(): void {
        void this.cleanupAsync().catch(e => {
            console.error('Failed to cleanup IndexedDB queue entries', e);
        });
    }

    async cleanupAsync(): Promise<boolean> {
        return await RateLimiter.tryToExecuteOrDefault(
            this.cleanupRateLimiter,
            async () => await this.cleanupNow(),
            false,
        );
    }

    private async cleanupNow(): Promise<boolean> {
        const db = await this.openDb();

        return await new Promise<boolean>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            let removedEntries = 0;

            tx.oncomplete = () => {
                if (removedEntries > 0) {
                    console.log('Removed entries: ', removedEntries);
                }
                resolve(removedEntries > 0);
            };
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB cleanup aborted'));
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB cleanup failed'));

            const request = store.openCursor();
            request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed during cleanup'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    return;
                }

                const stored = cursor.value as StoredResourceEntry;
                if (COMPLETED_STATUSES.has(stored.status) || this.isExpiredStoredEntry(stored)) {
                    removedEntries += 1;
                    const deleteRequest = cursor.delete();
                    deleteRequest.onerror = () => reject(deleteRequest.error ?? new Error('IndexedDB delete failed during cleanup'));
                }

                cursor.continue();
            };
        });
    }

    async enqueue(resourceEntry: ResourceEntry): Promise<ResourceEntry | undefined> {
        const db = await this.openDb();

        return await new Promise<ResourceEntry | undefined>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const keyString = toKeyAsString(resourceEntry.key);
            let previous: ResourceEntry | undefined;

            tx.oncomplete = () => resolve(previous);
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB enqueue aborted'));
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB enqueue failed'));

            const getRequest = store.get(keyString);
            getRequest.onerror = () => reject(getRequest.error ?? new Error('IndexedDB get failed during enqueue'));
            getRequest.onsuccess = () => {
                const stored = getRequest.result as StoredResourceEntry | undefined;
                previous = stored ? this.toResourceEntry(stored) : undefined;

                const putRequest = store.put(this.toStoredEntry(resourceEntry));
                putRequest.onerror = () => reject(putRequest.error ?? new Error('IndexedDB put failed during enqueue'));
            };
        });
    }

    async enqueueIfAbsent(resourceEntry: ResourceEntry): Promise<ResourceEntry> {
        const db = await this.openDb();

        return await new Promise<ResourceEntry>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const keyString = toKeyAsString(resourceEntry.key);
            let result = resourceEntry;

            tx.oncomplete = () => resolve(result);
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB enqueueIfAbsent aborted'));
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB enqueueIfAbsent failed'));

            const getRequest = store.get(keyString);
            getRequest.onerror = () => reject(getRequest.error ?? new Error('IndexedDB get failed during enqueueIfAbsent'));
            getRequest.onsuccess = () => {
                const stored = getRequest.result as StoredResourceEntry | undefined;
                if (stored && !this.isExpiredStoredEntry(stored)) {
                    console.log('Entry already exists: ', resourceEntry.key);
                    result = this.toResourceEntry(stored);
                    return;
                }

                const writeRequest = stored
                    ? store.put(this.toStoredEntry(resourceEntry))
                    : store.add(this.toStoredEntry(resourceEntry));
                writeRequest.onerror = () => reject(writeRequest.error ?? new Error('IndexedDB write failed during enqueueIfAbsent'));
            };
        });
    }

    async enqueueIf(
        resourceEntry: ResourceEntry,
        enqueueIt: (existing: ResourceEntry) => boolean,
    ): Promise<ResourceEntry | undefined> {
        const db = await this.openDb();

        return await new Promise<ResourceEntry | undefined>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const keyString = toKeyAsString(resourceEntry.key);
            let result: ResourceEntry | undefined;

            tx.oncomplete = () => resolve(result);
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB enqueueIf aborted'));
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB enqueueIf failed'));

            const getRequest = store.get(keyString);
            getRequest.onerror = () => reject(getRequest.error ?? new Error('IndexedDB get failed during enqueueIf'));
            getRequest.onsuccess = () => {
                const stored = getRequest.result as StoredResourceEntry | undefined;
                if (stored && !this.isExpiredStoredEntry(stored)) {
                    const previous = this.toResourceEntry(stored);
                    result = previous;

                    let shouldOverwrite: boolean;
                    try {
                        shouldOverwrite = enqueueIt(previous);
                    } catch (error) {
                        reject(error);
                        tx.abort();
                        return;
                    }

                    if (!shouldOverwrite) {
                        console.log('Entry already exists: ', resourceEntry.key);
                        return;
                    }
                }

                const writeRequest = store.put(this.toStoredEntry(resourceEntry));
                writeRequest.onerror = () => reject(writeRequest.error ?? new Error('IndexedDB write failed during enqueueIf'));
            };
        });
    }

    async enqueueOrUpdate(
        resourceEntry: ResourceEntry,
        updateExisting: (existing: ResourceEntry) => ResourceEntry | undefined,
    ) {
        const db = await this.openDb();

        return await new Promise<{
            action: 'inserted' | 'updated' | 'unchanged';
            entry: ResourceEntry;
            previous?: ResourceEntry;
        }>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const keyString = toKeyAsString(resourceEntry.key);
            let result: {
                action: 'inserted' | 'updated' | 'unchanged';
                entry: ResourceEntry;
                previous?: ResourceEntry;
            } = {
                action: 'inserted',
                entry: resourceEntry,
            };

            tx.oncomplete = () => resolve(result);
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB enqueueOrUpdate aborted'));
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB enqueueOrUpdate failed'));

            const getRequest = store.get(keyString);
            getRequest.onerror = () => reject(getRequest.error ?? new Error('IndexedDB get failed during enqueueOrUpdate'));
            getRequest.onsuccess = () => {
                const stored = getRequest.result as StoredResourceEntry | undefined;
                if (!stored || this.isExpiredStoredEntry(stored)) {
                    const writeRequest = store.put(this.toStoredEntry(resourceEntry));
                    writeRequest.onerror = () => reject(writeRequest.error ?? new Error('IndexedDB write failed during enqueueOrUpdate'));
                    return;
                }

                const previous = this.toResourceEntry(stored);
                let updated: ResourceEntry | undefined;
                try {
                    updated = updateExisting(previous);
                } catch (error) {
                    reject(error);
                    tx.abort();
                    return;
                }

                if (!updated) {
                    console.log('Entry already exists: ', resourceEntry.key);
                    result = {
                        action: 'unchanged',
                        entry: previous,
                        previous,
                    };
                    return;
                }

                result = {
                    action: 'updated',
                    entry: updated,
                    previous,
                };
                const writeRequest = store.put(this.toStoredEntry(updated));
                writeRequest.onerror = () => reject(writeRequest.error ?? new Error('IndexedDB update failed during enqueueOrUpdate'));
            };
        });
    }

    async releaseEntries(
        resources: ResourceEntry[],
        entityStatus: EntityStatus,
        exponentialBackoffSteps?: Temporal.TimeUnit,
    ): Promise<Map<Key, ResourceEntry>> {
        if (resources.length === 0) {
            return new Map<Key, ResourceEntry>();
        }

        const db = await this.openDb();
        const released = new Map<Key, ResourceEntry>();

        return await new Promise<Map<Key, ResourceEntry>>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);

            tx.oncomplete = () => resolve(released);
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB releaseEntries aborted'));
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB releaseEntries failed'));

            for (const resource of resources) {
                const backoff =
                    exponentialBackoffSteps
                        ? this.toBackoff(exponentialBackoffSteps, resource.dequeueAudit.attempts)
                        : undefined;
                const keyString = toKeyAsString(resource.key);
                const getRequest = store.get(keyString);
                getRequest.onerror = () => reject(getRequest.error ?? new Error('IndexedDB get failed during releaseEntries'));
                getRequest.onsuccess = () => {
                    const stored = getRequest.result as StoredResourceEntry | undefined;
                    const current = stored && !this.isExpiredStoredEntry(stored)
                        ? this.toResourceEntry(stored)
                        : resource;
                    const updated: ResourceEntry = {
                        ...current,
                        status: entityStatus,
                        dequeueAudit: {
                            startTs: resource.dequeueAudit.startTs,
                            endTs: Temporal.Now.instant(),
                            nextTs: backoff ? Temporal.Now.instant().add(backoff) : undefined,
                            attempts: resource.dequeueAudit.attempts,
                        },
                    };

                    released.set(updated.key, updated);

                    const putRequest = store.put(this.toStoredEntry(updated));
                    putRequest.onerror = () => reject(putRequest.error ?? new Error('IndexedDB put failed during releaseEntries'));
                };
            }
        });
    }

    async reserveTimeoutEntries(
        typeIds: Set<string>,
        maxToReserve: number,
        timeSinceStartTs: Temporal.Duration,
    ): Promise<Map<Key, ResourceEntry>> {
        const db = await this.openDb();
        const reserved = new Map<Key, ResourceEntry>();
        const now = Temporal.Now.instant();

        return await new Promise<Map<Key, ResourceEntry>>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const timeoutRequest = store.openCursor();

            tx.oncomplete = () => resolve(reserved);
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB reserveTimeoutEntries aborted'));
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB reserveTimeoutEntries failed'));

            timeoutRequest.onerror = () => reject(timeoutRequest.error ?? new Error('IndexedDB cursor failed during reserveTimeoutEntries'));
            timeoutRequest.onsuccess = () => {
                const cursor = timeoutRequest.result;
                if (!cursor || reserved.size >= maxToReserve) {
                    return;
                }

                const stored = cursor.value as StoredResourceEntry;
                if (!this.isTimedOutReservedEntry(stored, typeIds, timeSinceStartTs, now)) {
                    cursor.continue();
                    return;
                }

                const updated = this.toReservedEntry(this.toResourceEntry(stored), now);
                const updateRequest = cursor.update(this.toStoredEntry(updated));
                updateRequest.onerror = () => reject(updateRequest.error ?? new Error('IndexedDB update failed during reserveTimeoutEntries'));
                updateRequest.onsuccess = () => {
                    reserved.set(updated.key, updated);
                    cursor.continue();
                };
            };
        });
    }

    async reserveEntries(
        typeIds: Set<string>,
        statusIds: Set<EntityStatus>,
        maxToReserve: number,
    ): Promise<Map<Key, ResourceEntry>> {
        const db = await this.openDb();
        const reserved = new Map<Key, ResourceEntry>();
        const now = Temporal.Now.instant();

        return await new Promise<Map<Key, ResourceEntry>>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const request = store.openCursor();

            tx.oncomplete = () => resolve(reserved);
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB reserveEntries aborted'));
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB reserveEntries failed'));

            request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed during reserveEntries'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor || reserved.size >= maxToReserve) {
                    return;
                }

                const stored = cursor.value as StoredResourceEntry;
                if (!this.isReservableEntry(stored, typeIds, statusIds, now)) {
                    if (this.isExpiredStoredEntry(stored)) {
                        const deleteRequest = cursor.delete();
                        deleteRequest.onerror = () => reject(deleteRequest.error ?? new Error('IndexedDB delete failed during reserveEntries'));
                    }
                    cursor.continue();
                    return;
                }

                const updated = this.toReservedEntry(this.toResourceEntry(stored), now);
                const updateRequest = cursor.update(this.toStoredEntry(updated));
                updateRequest.onerror = () => reject(updateRequest.error ?? new Error('IndexedDB update failed during reserveEntries'));
                updateRequest.onsuccess = () => {
                    reserved.set(updated.key, updated);
                    cursor.continue();
                };
            };
        });
    }

    async isAnyEntryToLock(typeIds: Set<string>, checkTimeout: RateLimiter, checkFailed: RateLimiter): Promise<boolean> {
        const isFailedEntryToLock =
            await RateLimiter.tryToExecuteOrDefault(
                checkFailed,
                async () => await this.hasAnyReservableEntry(typeIds, FAILED_STATUS),
                false,
            );

        const isTimedOutEntryToLock =
            await RateLimiter.tryToExecuteOrDefault(
                checkTimeout,
                async () => await this.hasAnyTimedOutReservedEntry(typeIds, TIMEOUT_ON_NON_RESPONSIVE_ENTRY),
                false,
            );

        const newAndRetryEntryToLock = await this.hasAnyReservableEntry(typeIds, NEW_AND_RETRY_STATUSES);

        void this.cleanupAsync().catch(e => {
            console.error('Failed to cleanup entries', e);
        });

        return newAndRetryEntryToLock || isTimedOutEntryToLock || isFailedEntryToLock;
    }

    private async hasAnyReservableEntry(
        typeIds: Set<string>,
        statusesToFind: ReadonlySet<EntityStatus>,
    ): Promise<boolean> {
        return await this.findAnyStoredEntry(stored => {
            const now = Temporal.Now.instant();
            return this.isReservableEntry(stored, typeIds, statusesToFind, now);
        });
    }

    private async hasAnyTimedOutReservedEntry(
        typeIds: Set<string>,
        duration: Temporal.Duration,
    ): Promise<boolean> {
        return await this.findAnyStoredEntry(stored => {
            const now = Temporal.Now.instant();
            return this.isTimedOutReservedEntry(stored, typeIds, duration, now);
        });
    }

    private async findAnyStoredEntry(predicate: (stored: StoredResourceEntry) => boolean): Promise<boolean> {
        const db = await this.openDb();

        return await new Promise<boolean>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const request = store.openCursor();
            let found = false;

            tx.oncomplete = () => resolve(found);
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB read aborted'));
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB read failed'));

            request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor || found) {
                    return;
                }

                const stored = cursor.value as StoredResourceEntry;
                if (predicate(stored)) {
                    found = true;
                    return;
                }

                cursor.continue();
            };
        });
    }

    private isReservableEntry(
        stored: StoredResourceEntry,
        typeIds: ReadonlySet<string>,
        statusIds: ReadonlySet<EntityStatus>,
        now: Temporal.Instant,
    ): boolean {
        if (this.isExpiredStoredEntry(stored, now)) {
            return false;
        }

        if (!typeIds.has(stored.typeId) || !statusIds.has(stored.status)) {
            return false;
        }

        if (!stored.dequeueAudit.nextTs) {
            return true;
        }

        return Temporal.Instant.compare(now, Temporal.Instant.from(stored.dequeueAudit.nextTs)) >= 0;
    }

    private isTimedOutReservedEntry(
        stored: StoredResourceEntry,
        typeIds: ReadonlySet<string>,
        duration: Temporal.Duration,
        now: Temporal.Instant,
    ): boolean {
        if (this.isExpiredStoredEntry(stored, now)) {
            return false;
        }

        if (!typeIds.has(stored.typeId) || stored.status !== EntityStatus.RESERVED || !stored.dequeueAudit.startTs) {
            return false;
        }

        const startTs = Temporal.Instant.from(stored.dequeueAudit.startTs);
        return Temporal.Instant.compare(now, startTs.add(duration)) >= 0;
    }

    private toReservedEntry(entry: ResourceEntry, now: Temporal.Instant): ResourceEntry {
        return {
            ...entry,
            status: EntityStatus.RESERVED,
            dequeueAudit: {
                startTs: now,
                endTs: undefined,
                nextTs: undefined,
                attempts: entry.dequeueAudit.attempts + 1,
            },
        };
    }

    private isExpiredStoredEntry(
        stored: StoredResourceEntry,
        now: Temporal.Instant = Temporal.Now.instant(),
    ): boolean {
        const expiryTs = stored.audit.expiryTs
            ? toInstant(stored.audit.expiryTs)
            : NEVER_EXPIRE_TS;
        return Temporal.Instant.compare(now, expiryTs) >= 0;
    }

    private toBackoff(exponentialBackoffSteps: Temporal.TimeUnit, attempts: number): Temporal.Duration {
        switch (exponentialBackoffSteps) {
            case 'hour':
                return Temporal.Duration.from({ hours: Math.pow(2, attempts) });
            case 'minute':
                return Temporal.Duration.from({ minutes: Math.pow(2, attempts) });
            case 'second':
                return Temporal.Duration.from({ seconds: Math.pow(2, attempts) });
            case 'millisecond':
            case 'microsecond':
            case 'nanosecond':
                return Temporal.Duration.from({ milliseconds: Math.pow(2, attempts) });
            default:
                return Temporal.Duration.from({ seconds: Math.pow(2, attempts) });
        }
    }

    private async openDb(): Promise<IDBDatabase> {
        if (!IndexedDbQueueBox.isSupported()) {
            throw new Error('IndexedDB is not available in this runtime');
        }

        if (!this.dbPromise) {
            this.dbPromise = openIndexedDbWithStore(
                this.dbName,
                {
                    name: this.storeName,
                    keyPath: 'keyString',
                },
            ).then(db => {
                db.onversionchange = () => {
                    db.close();
                    this.dbPromise = undefined;
                };
                return db;
            });
        }

        return await this.dbPromise;
    }

    private toStoredEntry(entry: ResourceEntry): StoredResourceEntry {
        return {
            keyString: toKeyAsString(entry.key),
            key: entry.key,
            resource: entry.resource,
            typeId: entry.typeId,
            audit: {
                date: toPlainTime(entry.audit.date).toString(),
                createdBy: entry.audit.createdBy,
                createdTs: toPlainDateTime(entry.audit.createdTs).toString(),
                expiryTs: toInstant(entry.audit.expiryTs).toString(),
            },
            status: entry.status,
            dequeueAudit: {
                startTs: toOptionalInstant(entry.dequeueAudit.startTs)?.toString(),
                endTs: toOptionalInstant(entry.dequeueAudit.endTs)?.toString(),
                nextTs: toOptionalInstant(entry.dequeueAudit.nextTs)?.toString(),
                attempts: entry.dequeueAudit.attempts,
            },
        };
    }

    private toResourceEntry(stored: StoredResourceEntry): ResourceEntry {
        return {
            key: stored.key,
            resource: stored.resource,
            typeId: stored.typeId,
            audit: {
                date: toPlainTime(stored.audit.date),
                createdBy: stored.audit.createdBy,
                createdTs: toPlainDateTime(stored.audit.createdTs),
                expiryTs: stored.audit.expiryTs
                    ? toInstant(stored.audit.expiryTs)
                    : NEVER_EXPIRE_TS,
            },
            status: stored.status,
            dequeueAudit: {
                startTs: toOptionalInstant(stored.dequeueAudit.startTs),
                endTs: toOptionalInstant(stored.dequeueAudit.endTs),
                nextTs: toOptionalInstant(stored.dequeueAudit.nextTs),
                attempts: stored.dequeueAudit.attempts,
            },
            db: {
                id: stored.keyString,
            },
        };
    }

    async getItem(key: Key): Promise<ResourceEntry | undefined> {
        const db = await this.openDb();
        return await new Promise<ResourceEntry | undefined>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const request = store.get(toKeyAsString(key));
            request.onsuccess = () => {
                const stored = request.result as StoredResourceEntry | undefined;
                if (!stored) {
                    resolve(undefined);
                    return;
                }

                if (this.isExpiredStoredEntry(stored)) {
                    const deleteRequest = store.delete(toKeyAsString(key));
                    deleteRequest.onsuccess = () => resolve(undefined);
                    deleteRequest.onerror = () => reject(deleteRequest.error);
                    return;
                }

                resolve(this.toResourceEntry(stored));
            };
            request.onerror = () => reject(request.error);
        });
    }

    async setItem(
        key: Key,
        value: ResourceEntry,
        _options: PersistenceSetItemOptions,
    ): Promise<void> {
        const db = await this.openDb();
        const entry: ResourceEntry = {
            ...value,
            key,
        };
        return await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const request = store.put(this.toStoredEntry(entry));
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async removeItem(key: Key): Promise<void> {
        const db = await this.openDb();
        return await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const request = store.delete(toKeyAsString(key));
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async getAllKeys(): Promise<Key[]> {
        const db = await this.openDb();
        return await new Promise<Key[]>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const request = store.openCursor();
            const keys: Key[] = [];

            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve(keys);
                    return;
                }

                const stored = cursor.value as StoredResourceEntry;
                if (this.isExpiredStoredEntry(stored)) {
                    const deleteRequest = cursor.delete();
                    deleteRequest.onerror = () => reject(deleteRequest.error);
                    cursor.continue();
                    return;
                }

                keys.push(stored.key);
                cursor.continue();
            };
            request.onerror = () => reject(request.error);
        });
    }

    async deleteExpired(): Promise<number> {
        const db = await this.openDb();

        return await new Promise<number>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const request = store.openCursor();
            let deleted = 0;

            tx.oncomplete = () => resolve(deleted);
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB deleteExpired aborted'));
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB deleteExpired failed'));

            request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed during deleteExpired'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    return;
                }

                const stored = cursor.value as StoredResourceEntry;
                if (!this.isExpiredStoredEntry(stored)) {
                    cursor.continue();
                    return;
                }

                deleted += 1;
                const deleteRequest = cursor.delete();
                deleteRequest.onerror = () => reject(deleteRequest.error ?? new Error('IndexedDB delete failed during deleteExpired'));
                cursor.continue();
            };
        });
    }
}
