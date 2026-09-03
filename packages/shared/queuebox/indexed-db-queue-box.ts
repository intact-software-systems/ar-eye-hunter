import { Temporal } from '@js-temporal/polyfill';
import { EnqueuedType } from '../api/api-config.ts';
import { openIndexedDbWithStore } from '../persistence/openIndexedDb.ts';
import type { PersistenceSetItemOptions } from '../persistence/PersistenceProvider.ts';
import { RateLimiter } from '../resilience/Resilience.ts';
import { ResilienceDto } from './DequeueResourceEntryController.ts';
import {
    ComputedIndexedDbQueueMutation,
    computeIndexedDbQueueDelete,
    computeIndexedDbQueuePut,
    computeReservedQueueEntry,
    decodeStoredResourceEntry,
    isStoredQueueEntryExpired,
    isStoredQueueEntryReservable,
    isStoredQueueEntryTimedOut,
    StoredResourceEntry
} from './indexed-db-queue-box-entry.ts';
import { computeIndexedDbFairnessReservation } from './indexed-db-queue-box-fairness.ts';
import { computeIndexedDbQueueRelease } from './indexed-db-queue-box-release.ts';
import {
    readAllStoredQueueEntries,
    readFairnessStoredQueueEntries,
    readStoredQueueEntries,
    readStoredQueueEntry
} from './indexed-db-queue-box-store.ts';
import {
    QueueBoxResourceEntryRepository,
    ResourceInboxFairnessReservationInput,
    ResourceInboxFairnessSelection,
    ResourceInboxFinalizationReservationOptions,
    ResourceInboxFinalizationSelection,
    ResourceInboxReleaseDisposition,
    ResourceInboxReservationInput,
    ResourceInboxWorkAdvertisementOptions,
    toResourceInboxFairnessReservationOptions,
    toResourceInboxFinalizationReservationOptions,
    toResourceInboxReleaseDisposition,
    toResourceInboxReservationOptions,
    toResourceInboxWorkAdvertisementOptions
} from './queue-box-types.ts';
import {
    COMPLETED_STATUSES,
    EntityStatus,
    Key,
    NEW_AND_RETRY_STATUSES,
    ResourceEntry,
    TIMEOUT_ON_NON_RESPONSIVE_ENTRY,
    toKeyAsString
} from './ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from './ResourceInboxRetryPolicy.ts';
import { writeComputedIndexedDbQueueMutations } from './write-computed-indexed-db-queue-mutations.ts';

type IndexedDbQueueWriteOperation<Result> = Readonly<{
    mutations: readonly ComputedIndexedDbQueueMutation[];
    result: Result;
}>;

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

    private readonly cleanupRateLimiter: RateLimiter = RateLimiter.init(
        ResilienceDto.RATE_LIMITER_RESERVED_TIMEOUT_SLIDING_WINDOW_DURATION_MS,
        ResilienceDto.MAX_NUM_IS_ENTRY_CHECK
    );

    constructor(options: IndexedDbQueueBoxOptions = {}) {
        this.dbName = options.dbName ?? IndexedDbQueueBox.DEFAULT_DB_NAME;
        this.storeName = options.storeName ?? IndexedDbQueueBox.DEFAULT_STORE_NAME;
    }

    static isSupported(): boolean {
        return typeof indexedDB !== 'undefined';
    }

    cleanup(): void {
        void this.cleanupAsync().catch((e) => {
            console.error('Failed to cleanup IndexedDB queue entries', e);
        });
    }

    async cleanupAsync(): Promise<boolean> {
        return await RateLimiter.tryToExecuteOrDefault(
            this.cleanupRateLimiter,
            async () => await this.cleanupNow(),
            false
        );
    }

    private async cleanupNow(): Promise<boolean> {
        const db = await this.openDb();
        const now = Temporal.Now.instant();
        const removedEntries = await this.commitOnce(db, async () => {
            const entries = await readAllStoredQueueEntries(db, this.storeName);
            const expired = entries.filter(
                (stored) =>
                    COMPLETED_STATUSES.has(stored.status) ||
                    isStoredQueueEntryExpired(stored, now)
            );
            return {
                mutations: expired.map(computeIndexedDbQueueDelete),
                result: expired.length
            };
        });
        if (removedEntries > 0) {
            console.log('Removed entries: ', removedEntries);
        }
        return removedEntries > 0;
    }

    async enqueue(resourceEntry: ResourceEntry): Promise<ResourceEntry | undefined> {
        const db = await this.openDb();
        const keyString = toKeyAsString(resourceEntry.key);
        return await this.commitOnce(db, async () => {
            const stored = await readStoredQueueEntry(db, this.storeName, keyString);
            return {
                mutations: [computeIndexedDbQueuePut(stored, resourceEntry)],
                result: stored ? this.toResourceEntry(stored) : undefined
            };
        });
    }

    async enqueueIfAbsent(resourceEntry: ResourceEntry): Promise<ResourceEntry> {
        const db = await this.openDb();
        const keyString = toKeyAsString(resourceEntry.key);
        const result = await this.commitOnce<{
            entry: ResourceEntry;
            existing: boolean;
        }>(db, async () => {
            const stored = await readStoredQueueEntry(db, this.storeName, keyString);
            const now = Temporal.Now.instant();
            if (stored && !isStoredQueueEntryExpired(stored, now)) {
                return {
                    mutations: [],
                    result: { entry: this.toResourceEntry(stored), existing: true }
                };
            }
            return {
                mutations: [computeIndexedDbQueuePut(stored, resourceEntry)],
                result: { entry: resourceEntry, existing: false }
            };
        });
        if (result.existing) {
            console.log('Entry already exists: ', resourceEntry.key);
        }
        return result.entry;
    }

    async enqueueIf(
        resourceEntry: ResourceEntry,
        enqueueIt: (existing: ResourceEntry) => boolean
    ): Promise<ResourceEntry | undefined> {
        const db = await this.openDb();
        const keyString = toKeyAsString(resourceEntry.key);
        const result = await this.commitOnce<{
            previous: ResourceEntry | undefined;
            skipped: boolean;
        }>(db, async () => {
            const stored = await readStoredQueueEntry(db, this.storeName, keyString);
            const now = Temporal.Now.instant();
            if (stored && !isStoredQueueEntryExpired(stored, now)) {
                const previous = this.toResourceEntry(stored);
                if (!enqueueIt(previous)) {
                    return { mutations: [], result: { previous, skipped: true } };
                }
                return {
                    mutations: [computeIndexedDbQueuePut(stored, resourceEntry)],
                    result: { previous, skipped: false }
                };
            }
            return {
                mutations: [computeIndexedDbQueuePut(stored, resourceEntry)],
                result: { previous: undefined, skipped: false }
            };
        });
        if (result.skipped) {
            console.log('Entry already exists: ', resourceEntry.key);
        }
        return result.previous;
    }

    async enqueueOrUpdate(
        resourceEntry: ResourceEntry,
        updateExisting: (existing: ResourceEntry) => ResourceEntry | undefined
    ) {
        const db = await this.openDb();
        const keyString = toKeyAsString(resourceEntry.key);
        const result = await this.commitOnce<{
            action: 'inserted' | 'updated' | 'unchanged';
            entry: ResourceEntry;
            previous?: ResourceEntry;
        }>(db, async () => {
            const stored = await readStoredQueueEntry(db, this.storeName, keyString);
            const now = Temporal.Now.instant();
            if (!stored || isStoredQueueEntryExpired(stored, now)) {
                return {
                    mutations: [computeIndexedDbQueuePut(stored, resourceEntry)],
                    result: { action: 'inserted', entry: resourceEntry }
                };
            }

            const previous = this.toResourceEntry(stored);
            const updated = updateExisting(previous);
            if (!updated) {
                return {
                    mutations: [],
                    result: { action: 'unchanged', entry: previous, previous }
                };
            }
            return {
                mutations: [computeIndexedDbQueuePut(stored, updated)],
                result: { action: 'updated', entry: updated, previous }
            };
        });
        if (result.action === 'unchanged') {
            console.log('Entry already exists: ', resourceEntry.key);
        }
        return result;
    }

    async releaseEntries(
        resources: ResourceEntry[],
        releaseInput: ResourceInboxReleaseDisposition
    ): Promise<Map<Key, ResourceEntry>> {
        const disposition = toResourceInboxReleaseDisposition(releaseInput);
        if (resources.length === 0) {
            return new Map<Key, ResourceEntry>();
        }

        const db = await this.openDb();
        const releasedAt = Temporal.Now.instant();
        const keyStrings = resources.map((resource) => toKeyAsString(resource.key));
        return await this.commitOnce(db, async () => {
            const storedEntries = await readStoredQueueEntries(db, this.storeName, keyStrings);
            const currentEntries = new Map(
                [...storedEntries].map(([key, stored]) => [key, this.toResourceEntry(stored)])
            );
            return computeIndexedDbQueueRelease({
                currentEntries,
                disposition,
                releasedAt,
                resources,
                storedEntries
            });
        });
    }

    async reserveTimeoutEntries(
        typeIds: Set<string>,
        reservationInput: ResourceInboxReservationInput,
        timeSinceStartTs: Temporal.Duration
    ): Promise<Map<Key, ResourceEntry>> {
        const { maxToReserve, maxAttempts } = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        );
        const db = await this.openDb();
        const now = Temporal.Now.instant();
        return await this.commitOnce(db, async () => {
            const entries = await readAllStoredQueueEntries(db, this.storeName);
            const reserved = new Map<Key, ResourceEntry>();
            const mutations: ComputedIndexedDbQueueMutation[] = [];
            for (const stored of entries) {
                if (reserved.size >= maxToReserve) {
                    break;
                }
                if (
                    stored.dequeueAudit.attempts >= maxAttempts ||
                    !isStoredQueueEntryTimedOut({
                        stored,
                        typeIds,
                        duration: timeSinceStartTs,
                        now
                    })
                ) {
                    continue;
                }
                const updated = computeReservedQueueEntry(this.toResourceEntry(stored), now);
                reserved.set(updated.key, updated);
                mutations.push(computeIndexedDbQueuePut(stored, updated));
            }
            return { mutations, result: reserved };
        });
    }

    async reserveEntries(
        typeIds: Set<string>,
        statusIds: Set<EntityStatus>,
        reservationInput: ResourceInboxReservationInput
    ): Promise<Map<Key, ResourceEntry>> {
        const { maxToReserve, maxAttempts } = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        );
        const db = await this.openDb();
        const now = Temporal.Now.instant();
        return await this.commitOnce(db, async () => {
            const entries = await readAllStoredQueueEntries(db, this.storeName);
            const reserved = new Map<Key, ResourceEntry>();
            const mutations: ComputedIndexedDbQueueMutation[] = [];
            for (const stored of entries) {
                if (reserved.size >= maxToReserve) {
                    break;
                }
                if (
                    !isStoredQueueEntryReservable({
                        stored,
                        typeIds,
                        statusIds,
                        now,
                        maxAttempts
                    })
                ) {
                    if (isStoredQueueEntryExpired(stored, now)) {
                        mutations.push(computeIndexedDbQueueDelete(stored));
                    }
                    continue;
                }
                const updated = computeReservedQueueEntry(this.toResourceEntry(stored), now);
                reserved.set(updated.key, updated);
                mutations.push(computeIndexedDbQueuePut(stored, updated));
            }
            return { mutations, result: reserved };
        });
    }

    async reserveOverdueRetryEntries(
        typeIds: Set<string>,
        overdueBeforeEpochMs: number,
        reservationInput: ResourceInboxFairnessReservationInput
    ): Promise<Map<Key, ResourceInboxFairnessSelection>> {
        const options = toResourceInboxFairnessReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
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
        const now = Temporal.Now.instant();
        const requestedTypes = [...typeIds];
        return await this.commitOnce(db, async () => {
            const entriesByType = await readFairnessStoredQueueEntries({
                db,
                storeName: this.storeName,
                indexName: IndexedDbQueueBox.FAIRNESS_INDEX_NAME,
                typeIds: requestedTypes,
                overdueBeforeEpochMs,
                maxPerType: maxToScan
            });
            return computeIndexedDbFairnessReservation({
                entriesByType,
                maxAttempts,
                maxToReserve,
                maxToScan,
                now,
                requestedTypes
            });
        });
    }

    async reserveRetryExhaustionFinalizations(
        typeIds: Set<string>,
        input: ResourceInboxFinalizationReservationOptions
    ): Promise<Map<Key, ResourceInboxFinalizationSelection>> {
        const options = toResourceInboxFinalizationReservationOptions(input);
        if (!typeIds.has(EnqueuedType.APP_INBOX) || options.maxToReserve === 0) {
            return new Map();
        }
        const db = await this.openDb();
        const now = Temporal.Now.instant();
        const staleBefore = now.subtract({ milliseconds: options.staleAfterMs });
        return await this.commitOnce(db, async () => {
            const entries = await readAllStoredQueueEntries(db, this.storeName);
            const reserved = new Map<Key, ResourceInboxFinalizationSelection>();
            const mutations: ComputedIndexedDbQueueMutation[] = [];
            for (const stored of entries) {
                if (reserved.size >= options.maxToReserve) {
                    break;
                }
                const startTs = stored.dequeueAudit.startTs
                    ? Temporal.Instant.from(stored.dequeueAudit.startTs)
                    : undefined;
                const eligible = stored.typeId === EnqueuedType.APP_INBOX &&
                    stored.status === EntityStatus.RESERVED &&
                    !isStoredQueueEntryExpired(stored, now) &&
                    stored.dequeueAudit.attempts >= options.processingAttempts &&
                    stored.dequeueAudit.attempts < Number.MAX_SAFE_INTEGER &&
                    startTs !== undefined &&
                    Temporal.Instant.compare(startTs, staleBefore) <= 0;
                if (!eligible) {
                    continue;
                }
                const entry = this.toResourceEntry(stored);
                const updated: ResourceEntry = {
                    ...entry,
                    dequeueAudit: {
                        attempts: entry.dequeueAudit.attempts + 1,
                        startTs: now,
                        endTs: undefined,
                        nextTs: undefined
                    }
                };
                reserved.set(updated.key, { entry: updated, selectedDueTs: startTs });
                mutations.push(computeIndexedDbQueuePut(stored, updated));
            }
            return { mutations, result: reserved };
        });
    }

    async isAnyEntryToLock(
        typeIds: Set<string>,
        workInput: ResourceInboxWorkAdvertisementOptions
    ): Promise<boolean> {
        const { checkTimeout, checkFinalization, maxAttempts, finalizationStaleAfterMs } =
            toResourceInboxWorkAdvertisementOptions(workInput);
        const isTimedOutEntryToLock = await RateLimiter.tryToExecuteOrDefault(
            checkTimeout,
            async () =>
                await this.hasAnyTimedOutReservedEntry(
                    typeIds,
                    TIMEOUT_ON_NON_RESPONSIVE_ENTRY,
                    maxAttempts
                ),
            false
        );

        const newAndRetryEntryToLock = await this.hasAnyReservableEntry(
            typeIds,
            NEW_AND_RETRY_STATUSES,
            maxAttempts
        );
        const finalizationEntryToLock = await RateLimiter.tryToExecuteOrDefault(
            checkFinalization,
            () =>
                this.hasAnyRetryExhaustionFinalization(
                    typeIds,
                    maxAttempts,
                    finalizationStaleAfterMs
                ),
            false
        );

        void this.cleanupAsync().catch((e) => {
            console.error('Failed to cleanup entries', e);
        });

        return newAndRetryEntryToLock || isTimedOutEntryToLock || finalizationEntryToLock;
    }

    private async hasAnyRetryExhaustionFinalization(
        typeIds: Set<string>,
        processingAttempts: number,
        staleAfterMs: number
    ): Promise<boolean> {
        if (!typeIds.has(EnqueuedType.APP_INBOX)) {
            return false;
        }
        const now = Temporal.Now.instant();
        const staleBefore = now.subtract({ milliseconds: staleAfterMs });
        return await this.findAnyStoredEntry((stored) => {
            const startTs = stored.dequeueAudit.startTs
                ? Temporal.Instant.from(stored.dequeueAudit.startTs)
                : undefined;
            return stored.typeId === EnqueuedType.APP_INBOX &&
                stored.status === EntityStatus.RESERVED &&
                !isStoredQueueEntryExpired(stored, now) &&
                stored.dequeueAudit.attempts >= processingAttempts &&
                stored.dequeueAudit.attempts < Number.MAX_SAFE_INTEGER &&
                startTs !== undefined &&
                Temporal.Instant.compare(startTs, staleBefore) <= 0;
        });
    }

    private async hasAnyReservableEntry(
        typeIds: Set<string>,
        statusesToFind: ReadonlySet<EntityStatus>,
        maxAttempts: number
    ): Promise<boolean> {
        return await this.findAnyStoredEntry((stored) => {
            const now = Temporal.Now.instant();
            return isStoredQueueEntryReservable({
                stored,
                typeIds,
                statusIds: statusesToFind,
                now,
                maxAttempts
            });
        });
    }

    private async hasAnyTimedOutReservedEntry(
        typeIds: Set<string>,
        duration: Temporal.Duration,
        maxAttempts: number
    ): Promise<boolean> {
        return await this.findAnyStoredEntry((stored) => {
            const now = Temporal.Now.instant();
            return stored.dequeueAudit.attempts < maxAttempts &&
                isStoredQueueEntryTimedOut({ stored, typeIds, duration, now });
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

    private async commitOnce<Result>(
        db: IDBDatabase,
        createOperation: () => Promise<IndexedDbQueueWriteOperation<Result>>
    ): Promise<Result> {
        const operation = await createOperation();
        if (operation.mutations.length === 0) {
            return operation.result;
        }
        if (!await writeComputedIndexedDbQueueMutations(db, this.storeName, operation.mutations)) {
            throw new Error('IndexedDB queue write conflicted');
        }
        return operation.result;
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
                            'keyString'
                        ],
                        unique: false
                    }]
                }
            ).then((db) => {
                db.onversionchange = () => {
                    db.close();
                    this.dbPromise = undefined;
                };
                return db;
            });
        }

        return await this.dbPromise;
    }

    private toResourceEntry(stored: StoredResourceEntry): ResourceEntry {
        return decodeStoredResourceEntry(stored);
    }

    async getItem(key: Key): Promise<ResourceEntry | undefined> {
        const db = await this.openDb();
        const keyString = toKeyAsString(key);
        return await this.commitOnce(db, async () => {
            const stored = await readStoredQueueEntry(db, this.storeName, keyString);
            if (!stored) {
                return { mutations: [], result: undefined };
            }
            if (isStoredQueueEntryExpired(stored, Temporal.Now.instant())) {
                return { mutations: [computeIndexedDbQueueDelete(stored)], result: undefined };
            }
            return { mutations: [], result: this.toResourceEntry(stored) };
        });
    }

    async setItem(
        key: Key,
        value: ResourceEntry,
        _options: PersistenceSetItemOptions
    ): Promise<void> {
        const db = await this.openDb();
        const entry: ResourceEntry = {
            ...value,
            key
        };
        const keyString = toKeyAsString(key);
        await this.commitOnce(db, async () => {
            const stored = await readStoredQueueEntry(db, this.storeName, keyString);
            return { mutations: [computeIndexedDbQueuePut(stored, entry)], result: undefined };
        });
    }

    async removeItem(key: Key): Promise<void> {
        const db = await this.openDb();
        await writeComputedIndexedDbQueueMutations(db, this.storeName, [{
            keyString: toKeyAsString(key)
        }]);
    }

    async getAllKeys(): Promise<Key[]> {
        const db = await this.openDb();
        return await this.commitOnce(db, async () => {
            const entries = await readAllStoredQueueEntries(db, this.storeName);
            const now = Temporal.Now.instant();
            const keys: Key[] = [];
            const mutations: ComputedIndexedDbQueueMutation[] = [];
            for (const stored of entries) {
                if (isStoredQueueEntryExpired(stored, now)) {
                    mutations.push(computeIndexedDbQueueDelete(stored));
                }
                else {
                    keys.push(stored.key);
                }
            }
            return { mutations, result: keys };
        });
    }

    async deleteExpired(): Promise<number> {
        const db = await this.openDb();
        const now = Temporal.Now.instant();
        return await this.commitOnce(db, async () => {
            const entries = await readAllStoredQueueEntries(db, this.storeName);
            const expired = entries.filter((stored) => isStoredQueueEntryExpired(stored, now));
            return {
                mutations: expired.map(computeIndexedDbQueueDelete),
                result: expired.length
            };
        });
    }
}
