import { Temporal } from '@js-temporal/polyfill';
import type { PersistenceSetItemOptions } from '../persistence/PersistenceProvider.ts';
import { openIndexedDbWithStore } from '../persistence/openIndexedDb.ts';
import { RateLimiter } from '../resilience/Resilience.ts';
import { ResilienceDto } from './DequeueResourceEntryController.ts';
import {
    QueueBoxResourceEntryRepository,
    ResourceInboxFairnessReservationInput,
    ResourceInboxFairnessSelection,
    ResourceInboxFinalizationReservationOptions,
    ResourceInboxLostReservationError,
    ResourceInboxReleaseDisposition,
    ResourceInboxReservationInput,
    ResourceInboxWorkAdvertisementInput,
    isIdempotentCompletedAppInboxRelease,
    toResourceInboxFairnessReservationOptions,
    toResourceInboxFinalizationReservationOptions,
    toResourceInboxReleaseDisposition,
    toResourceInboxReservationOptions,
    toResourceInboxWorkAdvertisementOptions,
} from './QueueBoxTypes.ts';
import { EnqueuedType } from '../api/api-config.ts';
import {
    COMPLETED_STATUSES,
    EntityStatus,
    Key,
    NEVER_EXPIRE_TS,
    NEW_AND_RETRY_STATUSES,
    ResourceEntry,
    ResourceEntryKeyString,
    TIMEOUT_ON_NON_RESPONSIVE_ENTRY,
    toKeyAsString,
} from './ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from './ResourceInboxRetryPolicy.ts';

type StoredResourceEntry = Readonly<{
    keyString: ResourceEntryKeyString;
    fairnessDueEpochMs?: number;
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
    static readonly FAIRNESS_INDEX_NAME = 'by-type-status-next-key';

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
        releaseInput: ResourceInboxReleaseDisposition,
    ): Promise<Map<Key, ResourceEntry>> {
        const disposition = toResourceInboxReleaseDisposition(releaseInput);
        if (resources.length === 0) {
            return new Map<Key, ResourceEntry>();
        }

        const db = await this.openDb();
        const released = new Map<Key, ResourceEntry>();
        const releasedAt = Temporal.Now.instant();

        return await new Promise<Map<Key, ResourceEntry>>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);

            tx.oncomplete = () => resolve(released);
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB releaseEntries aborted'));
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB releaseEntries failed'));

            for (const resource of resources) {
                const keyString = toKeyAsString(resource.key);
                const getRequest = store.get(keyString);
                getRequest.onerror = () => reject(getRequest.error ?? new Error('IndexedDB get failed during releaseEntries'));
                getRequest.onsuccess = () => {
                    const stored = getRequest.result as StoredResourceEntry | undefined;
                    const current = stored ? this.toResourceEntry(stored) : undefined;
                    if (
                        !stored ||
                        !current ||
                        (
                            (
                                this.isExpiredStoredEntry(stored) ||
                                stored.status !== EntityStatus.RESERVED ||
                                stored.dequeueAudit.attempts !== resource.dequeueAudit.attempts
                            ) &&
                            !isIdempotentCompletedAppInboxRelease(
                                current,
                                resource,
                                disposition,
                            )
                        )
                    ) {
                        reject(new ResourceInboxLostReservationError(
                            resource.key,
                            resource.dequeueAudit.attempts,
                        ));
                        tx.abort();
                        return;
                    }
                    if (current.status === EntityStatus.COMPLETED) {
                        released.set(current.key, current);
                        return;
                    }
                    const updated: ResourceEntry = {
                        ...current,
                        status: disposition.status,
                        dequeueAudit: {
                            startTs: current.dequeueAudit.startTs,
                            endTs: releasedAt,
                            nextTs: disposition.delayMs !== null
                                ? releasedAt.add({ milliseconds: disposition.delayMs })
                                : undefined,
                            attempts: current.dequeueAudit.attempts,
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
        reservationInput: ResourceInboxReservationInput,
        timeSinceStartTs: Temporal.Duration,
    ): Promise<Map<Key, ResourceEntry>> {
        const { maxToReserve, maxAttempts } = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
        );
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
                if (
                    stored.dequeueAudit.attempts >= maxAttempts ||
                    !this.isTimedOutReservedEntry(stored, typeIds, timeSinceStartTs, now)
                ) {
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
        reservationInput: ResourceInboxReservationInput,
    ): Promise<Map<Key, ResourceEntry>> {
        const { maxToReserve, maxAttempts } = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
        );
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
                if (!this.isReservableEntry(stored, typeIds, statusIds, now, maxAttempts)) {
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

    async reserveOverdueRetryEntries(
        typeIds: Set<string>,
        overdueBeforeEpochMs: number,
        reservationInput: ResourceInboxFairnessReservationInput,
    ): Promise<Map<Key, ResourceInboxFairnessSelection>> {
        const options = toResourceInboxFairnessReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
        );
        const { maxToReserve, maxAttempts } = options;
        const maxToScan = typeof reservationInput === 'number'
            ? Math.max(options.maxToScan, typeIds.size)
            : options.maxToScan;
        if (typeIds.size === 0 || maxToReserve <= 0) {
            return new Map();
        }
        if (maxToScan < typeIds.size) {
            throw new Error('maxToScan must be at least the number of requested types');
        }

        const db = await this.openDb();
        const reserved = new Map<Key, ResourceInboxFairnessSelection>();
        const now = Temporal.Now.instant();
        const overdueBefore = Temporal.Instant.fromEpochMilliseconds(overdueBeforeEpochMs);

        return await new Promise<Map<Key, ResourceInboxFairnessSelection>>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const index = store.index(IndexedDbQueueBox.FAIRNESS_INDEX_NAME);
            const states = [...typeIds].map(typeId => ({
                typeId,
                ready: false,
                cursor: undefined as IDBCursorWithValue | undefined,
            }));
            let scanned = states.length;
            let stopped = false;

            tx.oncomplete = () => resolve(reserved);
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB fairness reservation aborted'));
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB fairness reservation failed'));

            const advanceOrDropCursor = (
                state: typeof states[number],
                cursor: IDBCursorWithValue,
            ) => {
                if (scanned >= maxToScan) {
                    state.cursor = undefined;
                    state.ready = true;
                    drain();
                    return;
                }

                scanned += 1;
                state.ready = false;
                cursor.continue();
            };

            const drain = () => {
                if (stopped || states.some(state => !state.ready)) {
                    return;
                }

                const available = states.filter(
                    (state): state is typeof state & { cursor: IDBCursorWithValue } =>
                        state.cursor !== undefined,
                );
                if (available.length === 0) {
                    return;
                }

                const selectedState = available.reduce((left, right) => {
                    const leftEntry = left.cursor.value as StoredResourceEntry;
                    const rightEntry = right.cursor.value as StoredResourceEntry;
                    const dueOrder = leftEntry.fairnessDueEpochMs! -
                        rightEntry.fairnessDueEpochMs!;
                    return dueOrder < 0 || (
                        dueOrder === 0 && indexedDB.cmp(
                            leftEntry.keyString,
                            rightEntry.keyString,
                        ) <= 0
                    ) ? left : right;
                });
                const cursor = selectedState.cursor;
                const stored = cursor.value as StoredResourceEntry;

                if (
                    this.isExpiredStoredEntry(stored, now) ||
                    stored.dequeueAudit.attempts >= maxAttempts
                ) {
                    advanceOrDropCursor(selectedState, cursor);
                    return;
                }

                const selectedDueTs = Temporal.Instant.from(stored.dequeueAudit.nextTs!);
                const entry = this.toReservedEntry(this.toResourceEntry(stored), now);
                selectedState.ready = false;
                const updateRequest = cursor.update(this.toStoredEntry(entry));
                updateRequest.onerror = () => reject(
                    updateRequest.error ?? new Error('IndexedDB fairness update failed'),
                );
                updateRequest.onsuccess = () => {
                    reserved.set(entry.key, { entry, selectedDueTs });
                    if (reserved.size >= maxToReserve) {
                        stopped = true;
                        return;
                    }
                    advanceOrDropCursor(selectedState, cursor);
                };
            };

            for (const state of states) {
                const request = index.openCursor(IDBKeyRange.bound(
                    [state.typeId, EntityStatus.RETRY, Number.MIN_SAFE_INTEGER, ''],
                    [
                        state.typeId,
                        EntityStatus.RETRY,
                        Number(overdueBefore.epochMilliseconds),
                        '\uffff',
                    ],
                ));
                request.onerror = () => reject(request.error ?? new Error('IndexedDB fairness cursor failed'));
                request.onsuccess = () => {
                    state.cursor = request.result ?? undefined;
                    state.ready = true;
                    drain();
                };
            }
        });
    }

    async reserveRetryExhaustionFinalizations(
        typeIds: Set<string>,
        input: ResourceInboxFinalizationReservationOptions,
    ): Promise<Map<Key, ResourceEntry>> {
        const options = toResourceInboxFinalizationReservationOptions(input);
        if (!typeIds.has(EnqueuedType.APP_INBOX) || options.maxToReserve === 0) {
            return new Map();
        }
        const db = await this.openDb();
        const now = Temporal.Now.instant();
        const staleBefore = now.subtract({ milliseconds: options.staleAfterMs });
        const reserved = new Map<Key, ResourceEntry>();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const request = tx.objectStore(this.storeName).openCursor();
            tx.oncomplete = () => resolve(reserved);
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB finalization reservation aborted'));
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB finalization reservation failed'));
            request.onerror = () => reject(request.error ?? new Error('IndexedDB finalization cursor failed'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor || reserved.size >= options.maxToReserve) return;
                const stored = cursor.value as StoredResourceEntry;
                const startTs = stored.dequeueAudit.startTs
                    ? Temporal.Instant.from(stored.dequeueAudit.startTs)
                    : undefined;
                const eligible = stored.typeId === EnqueuedType.APP_INBOX &&
                    stored.status === EntityStatus.RESERVED &&
                    !this.isExpiredStoredEntry(stored, now) &&
                    stored.dequeueAudit.attempts >= options.processingAttempts &&
                    startTs !== undefined &&
                    Temporal.Instant.compare(startTs, staleBefore) <= 0;
                if (!eligible) {
                    cursor.continue();
                    return;
                }
                if (stored.dequeueAudit.attempts >= Number.MAX_SAFE_INTEGER) {
                    tx.abort();
                    reject(new RangeError('Resource inbox finalization reservation generation overflow'));
                    return;
                }
                const entry = this.toResourceEntry(stored);
                const updated: ResourceEntry = {
                    ...entry,
                    dequeueAudit: {
                        attempts: entry.dequeueAudit.attempts + 1,
                        startTs: now,
                        endTs: undefined,
                        nextTs: undefined,
                    },
                };
                const update = cursor.update(this.toStoredEntry(updated));
                update.onerror = () => reject(update.error ?? new Error('IndexedDB finalization update failed'));
                update.onsuccess = () => {
                    reserved.set(updated.key, updated);
                    cursor.continue();
                };
            };
        });
    }

    async isAnyEntryToLock(
        typeIds: Set<string>,
        workInput: ResourceInboxWorkAdvertisementInput,
        legacyCheckFairness?: RateLimiter,
    ): Promise<boolean> {
        const { checkTimeout, checkFinalization, maxAttempts, finalizationStaleAfterMs } = toResourceInboxWorkAdvertisementOptions(
            workInput,
            legacyCheckFairness,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
        );
        const isTimedOutEntryToLock =
            await RateLimiter.tryToExecuteOrDefault(
                checkTimeout,
                async () => await this.hasAnyTimedOutReservedEntry(
                    typeIds,
                    TIMEOUT_ON_NON_RESPONSIVE_ENTRY,
                    maxAttempts,
                ),
                false,
            );

        const newAndRetryEntryToLock = await this.hasAnyReservableEntry(
            typeIds,
            NEW_AND_RETRY_STATUSES,
            maxAttempts,
        );
        const finalizationEntryToLock = await RateLimiter.tryToExecuteOrDefault(
            checkFinalization,
            () => this.hasAnyRetryExhaustionFinalization(
                typeIds,
                maxAttempts,
                finalizationStaleAfterMs,
            ),
            false,
        );

        void this.cleanupAsync().catch(e => {
            console.error('Failed to cleanup entries', e);
        });

        return newAndRetryEntryToLock || isTimedOutEntryToLock || finalizationEntryToLock;
    }

    private async hasAnyRetryExhaustionFinalization(
        typeIds: Set<string>,
        processingAttempts: number,
        staleAfterMs: number,
    ): Promise<boolean> {
        if (!typeIds.has(EnqueuedType.APP_INBOX)) return false;
        const now = Temporal.Now.instant();
        const staleBefore = now.subtract({ milliseconds: staleAfterMs });
        return await this.findAnyStoredEntry(stored => {
            const startTs = stored.dequeueAudit.startTs
                ? Temporal.Instant.from(stored.dequeueAudit.startTs)
                : undefined;
            return stored.typeId === EnqueuedType.APP_INBOX &&
                stored.status === EntityStatus.RESERVED &&
                !this.isExpiredStoredEntry(stored, now) &&
                stored.dequeueAudit.attempts >= processingAttempts &&
                stored.dequeueAudit.attempts < Number.MAX_SAFE_INTEGER &&
                startTs !== undefined &&
                Temporal.Instant.compare(startTs, staleBefore) <= 0;
        });
    }

    private async hasAnyReservableEntry(
        typeIds: Set<string>,
        statusesToFind: ReadonlySet<EntityStatus>,
        maxAttempts: number,
    ): Promise<boolean> {
        return await this.findAnyStoredEntry(stored => {
            const now = Temporal.Now.instant();
            return this.isReservableEntry(stored, typeIds, statusesToFind, now, maxAttempts);
        });
    }

    private async hasAnyTimedOutReservedEntry(
        typeIds: Set<string>,
        duration: Temporal.Duration,
        maxAttempts: number,
    ): Promise<boolean> {
        return await this.findAnyStoredEntry(stored => {
            const now = Temporal.Now.instant();
            return stored.dequeueAudit.attempts < maxAttempts &&
                this.isTimedOutReservedEntry(stored, typeIds, duration, now);
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
        maxAttempts: number = DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
    ): boolean {
        if (this.isExpiredStoredEntry(stored, now)) {
            return false;
        }

        if (!typeIds.has(stored.typeId) || !statusIds.has(stored.status)) {
            return false;
        }

        if (
            stored.status === EntityStatus.FAILED ||
            stored.dequeueAudit.attempts >= maxAttempts
        ) {
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
                    indexes: [{
                        name: IndexedDbQueueBox.FAIRNESS_INDEX_NAME,
                        keyPath: [
                            'typeId',
                            'status',
                            'fairnessDueEpochMs',
                            'keyString',
                        ],
                        unique: false,
                    }],
                    migrateOnUpgrade: store => this.migrateFairnessDueEpochMs(store),
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

    private migrateFairnessDueEpochMs(store: IDBObjectStore): void {
        const request = store.openCursor();
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
                return;
            }

            const stored = cursor.value as StoredResourceEntry;
            const nextTs = toOptionalInstant(stored.dequeueAudit.nextTs);
            const fairnessDueEpochMs = nextTs
                ? Number(nextTs.epochMilliseconds)
                : undefined;
            if (stored.fairnessDueEpochMs !== fairnessDueEpochMs) {
                cursor.update({
                    ...stored,
                    fairnessDueEpochMs,
                });
            }
            cursor.continue();
        };
    }

    private toStoredEntry(entry: ResourceEntry): StoredResourceEntry {
        return {
            keyString: toKeyAsString(entry.key),
            fairnessDueEpochMs: entry.dequeueAudit.nextTs
                ? Number(entry.dequeueAudit.nextTs.epochMilliseconds)
                : undefined,
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
                nextTs: toOptionalInstant(entry.dequeueAudit.nextTs)?.toString({
                    fractionalSecondDigits: 9,
                }),
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
