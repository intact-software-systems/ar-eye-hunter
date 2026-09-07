import { Temporal } from '@js-temporal/polyfill';
import { EnqueuedType } from '../api/api-config.ts';
import { IndexedDbConnection, openIndexedDbWithStores } from '../persistence/open-indexed-db.ts';
import type { PersistenceSetItemOptions } from '../persistence/PersistenceProvider.ts';
import { RateLimiter } from '../resilience/Resilience.ts';
import { computeIndexedDbFairnessReservation } from './compute-indexed-db-fairness-reservation.ts';
import { computeIndexedDbQueueRelease } from './compute-indexed-db-queue-release.ts';
import { ResilienceDto } from './DequeueResourceEntryController.ts';
import { hasSameResourceEntryValue } from './has-same-resource-entry-value.ts';
import {
    decodeStoredResourceEntry,
    type StoredResourceEntry
} from './indexed-db-queue-box-entry-codec.ts';
import {
    ComputedIndexedDbQueueMutation,
    computeIndexedDbQueueDelete,
    computeIndexedDbQueuePut,
    computeIndexedDbQueueUnconditionalDelete,
    computeReservedQueueEntry,
    isStoredQueueEntryExpired,
    isStoredQueueEntryReservable,
    isStoredQueueEntryTimedOut
} from './indexed-db-queue-box-entry.ts';
import {
    INDEXED_DB_QUEUE_FAIRNESS_INDEX_NAME,
    readAllStoredQueueEntries,
    readFairnessStoredQueueEntries,
    readStoredQueueEntries,
    readStoredQueueEntry,
    toIndexedDbQueueStoreDefinition
} from './indexed-db-queue-box-store.ts';
import { IndexedDbQueueWriteConflictError } from './indexed-db-queue-write-conflict-error.ts';
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
import { captureResourceEntryObservations, validateResourceEntryObservation } from './resource-entry-observations.ts';
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

export { IndexedDbQueueWriteConflictError } from './indexed-db-queue-write-conflict-error.ts';

interface IndexedDbQueueComputedWrite<Result> {
    readonly mutations: readonly ComputedIndexedDbQueueMutation[];
    readonly result: Result;
}

interface RetryExhaustionSelectionInput {
    readonly typeIds: ReadonlySet<string>;
    readonly stored: StoredResourceEntry;
    readonly processingAttempts: number;
    readonly now: Temporal.Instant;
    readonly staleBefore: Temporal.Instant;
}

export type IndexedDbQueueBoxOptions =
    | Readonly<{ dbName?: string; storeName?: string; connection?: never; }>
    | Readonly<{ connection: IndexedDbConnection; storeName: string; dbName?: never; }>;

export class IndexedDbQueueBox implements QueueBoxResourceEntryRepository {
    static readonly DEFAULT_DB_NAME = 'ar-eye-hunter-queuebox';
    static readonly DEFAULT_STORE_NAME = 'entries';

    readonly #connection: IndexedDbConnection;
    readonly #storeName: string;

    readonly #cleanupRateLimiter: RateLimiter = RateLimiter.init(
        ResilienceDto.RATE_LIMITER_RESERVED_TIMEOUT_SLIDING_WINDOW_DURATION_MS,
        ResilienceDto.MAX_NUM_IS_ENTRY_CHECK
    );

    constructor(options: IndexedDbQueueBoxOptions = {}) {
        const dbName = options.dbName ?? IndexedDbQueueBox.DEFAULT_DB_NAME;
        this.#storeName = options.storeName ?? IndexedDbQueueBox.DEFAULT_STORE_NAME;
        this.#connection = options.connection ?? new IndexedDbConnection(async () => {
            if (!IndexedDbQueueBox.isSupported()) {
                throw new Error('IndexedDB is not available in this runtime');
            }
            return await openIndexedDbWithStores(dbName, [toIndexedDbQueueStoreDefinition(this.#storeName)]);
        });
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
            this.#cleanupRateLimiter,
            async () => {
                const db = await this.#connection.open();
                const now = Temporal.Now.instant();
                const entries = await readAllStoredQueueEntries(db, this.#storeName);
                const expired = entries.filter(
                    (stored) =>
                        COMPLETED_STATUSES.has(stored.status) ||
                        isStoredQueueEntryExpired(stored, now)
                );
                const removedEntries = await this.#write(db, {
                    mutations: expired.map(computeIndexedDbQueueDelete),
                    result: expired.length
                });
                if (removedEntries > 0) {
                    console.log('Removed entries: ', removedEntries);
                }
                return removedEntries > 0;
            },
            false
        );
    }

    async enqueue(resourceEntry: ResourceEntry): Promise<ResourceEntry | undefined> {
        const db = await this.#connection.open();
        const keyString = toKeyAsString(resourceEntry.key);
        const stored = await readStoredQueueEntry(db, this.#storeName, keyString);
        return await this.#write(db, {
            mutations: [computeIndexedDbQueuePut(stored, resourceEntry)],
            result: stored ? decodeStoredResourceEntry(stored) : undefined
        });
    }

    async enqueueIfAbsent(resourceEntry: ResourceEntry): Promise<ResourceEntry> {
        const db = await this.#connection.open();
        const stored = await readStoredQueueEntry(
            db,
            this.#storeName,
            toKeyAsString(resourceEntry.key)
        );
        if (stored && !isStoredQueueEntryExpired(stored, Temporal.Now.instant())) {
            return decodeStoredResourceEntry(stored);
        }
        const computed = {
            mutations: [computeIndexedDbQueuePut(stored, resourceEntry)],
            result: resourceEntry
        };
        try {
            return await this.#write(db, computed);
        }
        catch (error) {
            if (!(error instanceof IndexedDbQueueWriteConflictError)) {
                throw error;
            }
            const winner = await this.getItem(resourceEntry.key);
            if (winner) {
                return winner;
            }
            throw error;
        }
    }

    async replaceIfObserved(
        expected: ResourceEntry,
        replacement: ResourceEntry
    ): Promise<ResourceEntry | null> {
        if (toKeyAsString(expected.key) !== toKeyAsString(replacement.key)) {
            throw new TypeError('Queue replacement key differs from its observation');
        }
        const db = await this.#connection.open();
        const keyString = toKeyAsString(expected.key);
        const stored = await readStoredQueueEntry(db, this.#storeName, keyString);
        if (
            !stored ||
            isStoredQueueEntryExpired(stored, Temporal.Now.instant()) ||
            !hasSameResourceEntryValue(decodeStoredResourceEntry(stored), expected)
        ) {
            return null;
        }

        const computed = {
            mutations: [computeIndexedDbQueuePut(stored, replacement)],
            result: replacement
        };
        try {
            return await this.#write(db, computed);
        }
        catch (error) {
            if (error instanceof IndexedDbQueueWriteConflictError) {
                return null;
            }
            throw error;
        }
    }

    async releaseEntries(
        resources: ResourceEntry[],
        releaseInput: ResourceInboxReleaseDisposition
    ): Promise<Map<Key, ResourceEntry>> {
        const disposition = toResourceInboxReleaseDisposition(releaseInput);
        if (resources.length === 0) {
            return new Map<Key, ResourceEntry>();
        }

        const db = await this.#connection.open();
        const releasedAt = Temporal.Now.instant();
        const keyStrings = resources.map((resource) => toKeyAsString(resource.key));
        const storedEntries = await readStoredQueueEntries(db, this.#storeName, keyStrings);
        const currentEntries = new Map(
            [...storedEntries].map(([key, stored]) => [key, decodeStoredResourceEntry(stored)])
        );
        const computed = computeIndexedDbQueueRelease({
            currentEntries,
            disposition,
            releasedAt,
            resources,
            storedEntries
        });
        return await this.#write(db, computed);
    }

    async reserveTimeoutEntries(
        typeIds: Set<string>,
        reservationInput: ResourceInboxReservationInput,
        timeSinceStartTs: Temporal.Duration,
        observedEntries?: readonly ResourceEntry[]
    ): Promise<Map<Key, ResourceEntry>> {
        const { maxToReserve, maxAttempts } = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        );
        const observations = captureResourceEntryObservations(observedEntries);
        if (observations?.size === 0 || maxToReserve === 0) {
            return new Map();
        }
        const db = await this.#connection.open();
        const now = Temporal.Now.instant();
        const entries = observations === undefined
            ? await readAllStoredQueueEntries(db, this.#storeName)
            : (await readStoredQueueEntries(
                db,
                this.#storeName,
                [...observations.values()].map((entry) => toKeyAsString(entry.key))
            )).values();
        const reserved = new Map<Key, ResourceEntry>();
        const mutations: ComputedIndexedDbQueueMutation[] = [];
        for (const stored of entries) {
            if (reserved.size >= maxToReserve) {
                break;
            }
            if (
                observations !== undefined &&
                validateResourceEntryObservation(decodeStoredResourceEntry(stored), observations).left
            ) {
                continue;
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
            const updated = computeReservedQueueEntry(decodeStoredResourceEntry(stored), now);
            reserved.set(updated.key, updated);
            mutations.push(computeIndexedDbQueuePut(stored, updated));
        }
        return await this.#write(db, { mutations, result: reserved });
    }

    async reserveEntries(
        typeIds: Set<string>,
        statusIds: Set<EntityStatus>,
        reservationInput: ResourceInboxReservationInput,
        observedEntries?: readonly ResourceEntry[]
    ): Promise<Map<Key, ResourceEntry>> {
        const { maxToReserve, maxAttempts } = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        );
        const observations = captureResourceEntryObservations(observedEntries);
        if (observations?.size === 0 || maxToReserve === 0) {
            return new Map();
        }
        const db = await this.#connection.open();
        const now = Temporal.Now.instant();
        const entries = observations === undefined
            ? await readAllStoredQueueEntries(db, this.#storeName)
            : (await readStoredQueueEntries(
                db,
                this.#storeName,
                [...observations.values()].map((entry) => toKeyAsString(entry.key))
            )).values();
        const reserved = new Map<Key, ResourceEntry>();
        const mutations: ComputedIndexedDbQueueMutation[] = [];
        for (const stored of entries) {
            if (reserved.size >= maxToReserve) {
                break;
            }
            if (
                observations !== undefined &&
                validateResourceEntryObservation(decodeStoredResourceEntry(stored), observations).left
            ) {
                continue;
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
            const updated = computeReservedQueueEntry(decodeStoredResourceEntry(stored), now);
            reserved.set(updated.key, updated);
            mutations.push(computeIndexedDbQueuePut(stored, updated));
        }
        return await this.#write(db, { mutations, result: reserved });
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

        const db = await this.#connection.open();
        const now = Temporal.Now.instant();
        const requestedTypes = [...typeIds];
        const entriesByType = await readFairnessStoredQueueEntries({
            db,
            storeName: this.#storeName,
            indexName: INDEXED_DB_QUEUE_FAIRNESS_INDEX_NAME,
            typeIds: requestedTypes,
            overdueBeforeEpochMs,
            maxToScan
        });
        const computed = computeIndexedDbFairnessReservation({
            entriesByType,
            maxAttempts,
            maxToReserve,
            maxToScan,
            now,
            requestedTypes
        });
        return await this.#write(db, computed);
    }

    async reserveRetryExhaustionFinalizations(
        typeIds: Set<string>,
        input: ResourceInboxFinalizationReservationOptions
    ): Promise<Map<Key, ResourceInboxFinalizationSelection>> {
        const options = toResourceInboxFinalizationReservationOptions(input);
        if (typeIds.size === 0 || options.maxToReserve === 0) {
            return new Map();
        }
        const db = await this.#connection.open();
        const now = Temporal.Now.instant();
        const staleBefore = now.subtract({ milliseconds: options.staleAfterMs });
        const entries = await readAllStoredQueueEntries(db, this.#storeName);
        const reserved = new Map<Key, ResourceInboxFinalizationSelection>();
        const mutations: ComputedIndexedDbQueueMutation[] = [];
        for (const stored of entries) {
            if (reserved.size >= options.maxToReserve) {
                break;
            }
            const selectedDueTs = selectRetryExhaustionDueTimestamp({
                typeIds,
                stored,
                processingAttempts: options.processingAttempts,
                now,
                staleBefore
            });
            if (!selectedDueTs) {
                continue;
            }
            const entry = decodeStoredResourceEntry(stored);
            const updated: ResourceEntry = {
                ...entry,
                dequeueAudit: {
                    attempts: entry.dequeueAudit.attempts + 1,
                    startTs: now,
                    endTs: undefined,
                    nextTs: undefined
                }
            };
            reserved.set(updated.key, { entry: updated, selectedDueTs });
            mutations.push(computeIndexedDbQueuePut(stored, updated));
        }
        return await this.#write(db, { mutations, result: reserved });
    }

    async isAnyEntryToLock(
        typeIds: Set<string>,
        workInput: ResourceInboxWorkAdvertisementOptions
    ): Promise<boolean> {
        const { checkTimeout, checkFinalization, maxAttempts, finalizationStaleAfterMs } =
            toResourceInboxWorkAdvertisementOptions(workInput);
        const db = await this.#connection.open();
        const entries = await readAllStoredQueueEntries(db, this.#storeName);
        const now = Temporal.Now.instant();
        const isTimedOutEntryToLock = await RateLimiter.tryToExecuteOrDefault(
            checkTimeout,
            async () =>
                entries.some((stored) =>
                    stored.dequeueAudit.attempts < maxAttempts &&
                    isStoredQueueEntryTimedOut({
                        stored,
                        typeIds,
                        duration: TIMEOUT_ON_NON_RESPONSIVE_ENTRY,
                        now
                    })
                ),
            false
        );

        const newAndRetryEntryToLock = entries.some((stored) =>
            isStoredQueueEntryReservable({
                stored,
                typeIds,
                statusIds: NEW_AND_RETRY_STATUSES,
                now,
                maxAttempts
            })
        );
        const finalizationEntryToLock = await RateLimiter.tryToExecuteOrDefault(
            checkFinalization,
            async () => {
                if (!typeIds.has(EnqueuedType.APP_INBOX)) {
                    return false;
                }
                const staleBefore = now.subtract({ milliseconds: finalizationStaleAfterMs });
                return entries.some((stored) =>
                    selectRetryExhaustionDueTimestamp({
                        typeIds: new Set([EnqueuedType.APP_INBOX]),
                        stored,
                        processingAttempts: maxAttempts,
                        now,
                        staleBefore
                    }) !== undefined
                );
            },
            false
        );

        void this.cleanupAsync().catch((e) => {
            console.error('Failed to cleanup entries', e);
        });

        return newAndRetryEntryToLock || isTimedOutEntryToLock || finalizationEntryToLock;
    }

    async #write<Result>(
        db: IDBDatabase,
        computed: IndexedDbQueueComputedWrite<Result>
    ): Promise<Result> {
        if (computed.mutations.length === 0) {
            return computed.result;
        }
        if (!await writeComputedIndexedDbQueueMutations(db, this.#storeName, computed.mutations)) {
            throw new IndexedDbQueueWriteConflictError('IndexedDB queue write conflicted');
        }
        return computed.result;
    }

    async getItem(key: Key): Promise<ResourceEntry | undefined> {
        const db = await this.#connection.open();
        const keyString = toKeyAsString(key);
        const stored = await readStoredQueueEntry(db, this.#storeName, keyString);
        if (!stored) {
            return undefined;
        }
        const computed: IndexedDbQueueComputedWrite<ResourceEntry | undefined> =
            isStoredQueueEntryExpired(stored, Temporal.Now.instant())
                ? { mutations: [computeIndexedDbQueueDelete(stored)], result: undefined }
                : { mutations: [], result: decodeStoredResourceEntry(stored) };
        return await this.#write(db, computed);
    }

    async setItem(
        key: Key,
        value: ResourceEntry,
        _options: PersistenceSetItemOptions
    ): Promise<void> {
        const db = await this.#connection.open();
        const entry: ResourceEntry = {
            ...value,
            key
        };
        const keyString = toKeyAsString(key);
        const stored = await readStoredQueueEntry(db, this.#storeName, keyString);
        await this.#write(db, {
            mutations: [computeIndexedDbQueuePut(stored, entry)],
            result: undefined
        });
    }

    async removeItem(key: Key): Promise<void> {
        const db = await this.#connection.open();
        await writeComputedIndexedDbQueueMutations(db, this.#storeName, [
            computeIndexedDbQueueUnconditionalDelete(toKeyAsString(key))
        ]);
    }

    async getAllKeys(): Promise<Key[]> {
        const db = await this.#connection.open();
        const entries = await readAllStoredQueueEntries(db, this.#storeName);
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
        return await this.#write(db, { mutations, result: keys });
    }

    async deleteExpired(): Promise<number> {
        const db = await this.#connection.open();
        const now = Temporal.Now.instant();
        const entries = await readAllStoredQueueEntries(db, this.#storeName);
        const expired = entries.filter((stored) => isStoredQueueEntryExpired(stored, now));
        return await this.#write(db, {
            mutations: expired.map(computeIndexedDbQueueDelete),
            result: expired.length
        });
    }
}

function selectRetryExhaustionDueTimestamp(
    input: RetryExhaustionSelectionInput
): Temporal.Instant | undefined {
    const startTs = input.stored.dequeueAudit.startTs
        ? Temporal.Instant.from(input.stored.dequeueAudit.startTs)
        : undefined;
    if (
        !input.typeIds.has(input.stored.typeId) ||
        input.stored.status !== EntityStatus.RESERVED ||
        isStoredQueueEntryExpired(input.stored, input.now) ||
        input.stored.dequeueAudit.attempts < input.processingAttempts ||
        input.stored.dequeueAudit.attempts >= Number.MAX_SAFE_INTEGER ||
        startTs === undefined ||
        Temporal.Instant.compare(startTs, input.staleBefore) > 0
    ) {
        return undefined;
    }
    return startTs;
}
