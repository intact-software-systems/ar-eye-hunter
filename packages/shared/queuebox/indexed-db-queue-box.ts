import { Temporal } from '@js-temporal/polyfill';
import { EnqueuedType } from '../api/api-config.ts';
import type { IndexedDbOperationObserver } from '../persistence/indexed-db-operation-observer.ts';
import { readIndexedDbRequest, readIndexedDbTransaction } from '../persistence/indexed-db-request.ts';
import { IndexedDbConnection, openIndexedDbWithStores } from '../persistence/open-indexed-db.ts';
import type { PersistenceSetItemOptions } from '../persistence/PersistenceProvider.ts';
import { RateLimiter } from '../resilience/Resilience.ts';
import { computeIndexedDbFairnessReservation } from './compute-indexed-db-fairness-reservation.ts';
import { computeIndexedDbQueueRelease } from './compute-indexed-db-queue-release.ts';
import { validateResourceInboxReleaseDisposition } from './compute-resource-inbox-release.ts';
import {
    decodeStoredResourceEntry,
    decodeStoredResourceEntryValue,
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
    readDeletableCompletedStoredQueueEntries,
    readExpiredStoredQueueEntries,
    readFairnessStoredQueueEntries,
    readStoredQueueEntries,
    readStoredQueueEntriesByTypesAndStatuses,
    readStoredQueueEntry,
    readStoredQueueWorkPage,
    toIndexedDbQueueStoreDefinition
} from './indexed-db-queue-box-store.ts';
import { IndexedDbQueueWriteConflictError } from './indexed-db-queue-write-conflict-error.ts';
import { matchesQueueBoxCompletedRetention, type QueueBoxCompletedRetention } from './queue-box-completed-retention.ts';
import {
    QueueBoxResourceEntryRepository,
    ResourceInboxFairnessReservationInput,
    ResourceInboxFairnessSelection,
    ResourceInboxFinalizationReservationOptions,
    ResourceInboxFinalizationSelection,
    ResourceInboxReleaseDisposition,
    ResourceInboxWorkAdvertisementOptions,
    ResourceInboxWorkPage,
    toResourceInboxFairnessReservationOptions,
    toResourceInboxFinalizationReservationOptions,
    toResourceInboxReservationOptions,
    toResourceInboxWorkAdvertisementOptions,
    type ResourceInboxReservationRequest,
    type ResourceInboxTimeoutReservationRequest
} from './queue-box-types.ts';
import {
    captureResourceEntryObservations,
    hasSameResourceEntryValue,
    validateResourceEntryObservation,
    validateResourceInboxWorkPageRequest
} from './resource-entry-observations.ts';
import { ResourceInboxResilience } from './resource-inbox/resource-inbox-resilience.ts';
import {
    COMPLETED_STATUSES,
    EntityStatus,
    Key,
    NEW_AND_RETRY_STATUSES,
    ResourceEntry,
    TIMEOUT_ON_NON_RESPONSIVE_ENTRY,
    toKeyAsString,
    type ResourceEntryKeyString
} from './ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from './ResourceInboxRetryPolicy.ts';
import { writeComputedIndexedDbQueueMutations } from './write-computed-indexed-db-queue-mutations.ts';

export { IndexedDbQueueWriteConflictError } from './indexed-db-queue-write-conflict-error.ts';

export interface IndexedDbQueueCleanupResult {
    readonly deleted: number;
    /** The pass deleted a whole per-reason budget, so more rows of that kind may remain. */
    readonly saturated: boolean;
}

/** Per-run cap on rows an opportunistic cleanupAsync() pass deletes for each reason. */
export const INDEXED_DB_QUEUE_CLEANUP_MAX_EXPIRED_TO_DELETE = 256;
const INDEXED_DB_QUEUE_CLEANUP_MAX_COMPLETED_TO_DELETE = 256;
/** Retained rows spend pages without spending deletions, so one run also gets a page budget. */
const INDEXED_DB_QUEUE_CLEANUP_MAX_COMPLETED_PAGES = 8;
/** Per-type row budget for advertisement probes and poison-skipping recovery scans. */
const INDEXED_DB_QUEUE_PROBE_MAX_TO_READ = 64;

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
    | Readonly<{
        dbName?: string;
        storeName?: string;
        connection?: never;
        completedRetention?: QueueBoxCompletedRetention;
        now?: () => Temporal.Instant;
        observer: IndexedDbOperationObserver;
    }>
    | Readonly<{
        connection: IndexedDbConnection;
        storeName: string;
        dbName?: never;
        completedRetention?: QueueBoxCompletedRetention;
        now?: () => Temporal.Instant;
        observer: IndexedDbOperationObserver;
    }>;

export class IndexedDbQueueBox implements QueueBoxResourceEntryRepository {
    static readonly DEFAULT_DB_NAME = 'ar-eye-hunter-queuebox';
    static readonly DEFAULT_STORE_NAME = 'entries';

    readonly #connection: IndexedDbConnection;
    readonly #now: () => Temporal.Instant;
    readonly #storeName: string;
    readonly #completedRetention: QueueBoxCompletedRetention;
    readonly #observer: IndexedDbOperationObserver;

    readonly #cleanupRateLimiter: RateLimiter = RateLimiter.init(
        ResourceInboxResilience.RATE_LIMITER_RESERVED_TIMEOUT_SLIDING_WINDOW_DURATION_MS,
        ResourceInboxResilience.MAX_NUM_IS_ENTRY_CHECK
    );

    constructor(options: IndexedDbQueueBoxOptions) {
        this.#observer = options.observer;
        this.#now = options.now ?? Temporal.Now.instant;
        this.#completedRetention = {
            typeIds: [...options.completedRetention?.typeIds ?? []],
            topicIds: [...options.completedRetention?.topicIds ?? []]
        };
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

    async readWorkPage(input: ResourceInboxWorkPage.Request): Promise<ResourceInboxWorkPage> {
        this.#observer.observe({ owner: 'al-work', kind: 'work-page' });
        const request = { ...input, cursor: input.cursor === null ? null : { ...input.cursor } };
        const validated = validateResourceInboxWorkPageRequest(request);
        if (validated.left) {
            throw validated.left;
        }
        const db = await this.#connection.open();
        const stored = await readStoredQueueWorkPage(db, this.#storeName, request);
        return {
            entries: stored.map(decodeStoredResourceEntry),
            nextCursor: stored.length === request.maxToRead
                ? { typeId: request.typeId, status: request.status, position: stored[stored.length - 1].keyString }
                : null
        };
    }

    /** The opportunistic sweep hot paths trigger: rate limited, so it runs at most once per window. */
    cleanup(): void {
        if (!this.#cleanupRateLimiter.allow()) {
            return;
        }
        void this.cleanupAsync().catch((e) => {
            console.error('Failed to cleanup IndexedDB queue entries', e);
        });
    }

    /**
     * One bounded pass. A pass that deletes a whole per-reason budget reports `saturated`, so a
     * caller that owns a bound of its own can run the next pass instead of leaving the remainder
     * until some later trigger.
     */
    async cleanupAsync(): Promise<IndexedDbQueueCleanupResult> {
        this.#observer.observe({ owner: 'al-work', kind: 'work-cleanup' });
        const db = await this.#connection.open();
        const now = this.#now();
        const expired = await this.#readExpiredEntries(db, now);
        const completed = await readDeletableCompletedStoredQueueEntries({
            db,
            storeName: this.#storeName,
            statusIds: COMPLETED_STATUSES,
            endAtOrBeforeEpochMs: Number(now.epochMilliseconds),
            maxToDelete: INDEXED_DB_QUEUE_CLEANUP_MAX_COMPLETED_TO_DELETE,
            maxPages: INDEXED_DB_QUEUE_CLEANUP_MAX_COMPLETED_PAGES,
            isDeletable: (stored) => !matchesQueueBoxCompletedRetention(stored, this.#completedRetention)
        });
        // A row can be expired and terminal at once; a duplicate key rejects the whole write.
        const toDelete = new Map<ResourceEntryKeyString, StoredResourceEntry>(
            [...expired, ...completed].map((stored) => [stored.keyString, stored])
        );
        const deleted = await this.#write(db, {
            mutations: [...toDelete.values()].map(computeIndexedDbQueueDelete),
            result: toDelete.size
        });
        return {
            deleted,
            saturated: expired.length >= INDEXED_DB_QUEUE_CLEANUP_MAX_EXPIRED_TO_DELETE ||
                completed.length >= INDEXED_DB_QUEUE_CLEANUP_MAX_COMPLETED_TO_DELETE
        };
    }

    async enqueue(resourceEntry: ResourceEntry): Promise<ResourceEntry | undefined> {
        this.#observer.observe({ owner: 'al-work', kind: 'work-write' });
        const db = await this.#connection.open();
        const keyString = toKeyAsString(resourceEntry.key);
        const stored = await readStoredQueueEntry(db, this.#storeName, keyString);
        return await this.#write(db, {
            mutations: [computeIndexedDbQueuePut(stored, resourceEntry)],
            result: stored ? decodeStoredResourceEntry(stored) : undefined
        });
    }

    async enqueueIfAbsent(resourceEntry: ResourceEntry): Promise<ResourceEntry> {
        this.#observer.observe({ owner: 'al-work', kind: 'work-write' });
        const db = await this.#connection.open();
        const stored = await readStoredQueueEntry(
            db,
            this.#storeName,
            toKeyAsString(resourceEntry.key)
        );
        if (stored && !isStoredQueueEntryExpired(stored, this.#now())) {
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
        this.#observer.observe({ owner: 'al-work', kind: 'work-write' });
        if (toKeyAsString(expected.key) !== toKeyAsString(replacement.key)) {
            throw new TypeError('Queue replacement key differs from its observation');
        }
        const db = await this.#connection.open();
        const keyString = toKeyAsString(expected.key);
        const stored = await readStoredQueueEntry(db, this.#storeName, keyString);
        if (
            !stored ||
            isStoredQueueEntryExpired(stored, this.#now()) ||
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
        this.#observer.observe({ owner: 'al-work', kind: 'work-release' });
        const disposition = validateResourceInboxReleaseDisposition(releaseInput).fold(
            (error) => {
                throw error;
            },
            (value) => value
        );
        if (resources.length === 0) {
            return new Map<Key, ResourceEntry>();
        }

        const db = await this.#connection.open();
        const releasedAt = this.#now();
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
        if (computed.right === undefined) {
            throw computed.left;
        }
        return await this.#write(db, computed.right);
    }

    async reserveTimeoutEntries(
        { typeIds, reservationInput, timeSinceStartTs, observedEntries }: ResourceInboxTimeoutReservationRequest
    ): Promise<Map<Key, ResourceEntry>> {
        this.#observer.observe({ owner: 'al-work', kind: 'work-reserve' });
        const { maxToReserve, maxAttempts } = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        );
        const observations = captureResourceEntryObservations(observedEntries);
        if (observations?.size === 0 || maxToReserve === 0) {
            return new Map();
        }
        const db = await this.#connection.open();
        const now = this.#now();
        const candidates = observations === undefined
            ? await readStoredQueueEntriesByTypesAndStatuses({
                db,
                storeName: this.#storeName,
                typeIds,
                statusIds: [EntityStatus.RESERVED],
                // Look ahead like the probe: a live RESERVED row sorting first must not hide older timed-out rows.
                maxToReadPerCombination: Math.max(maxToReserve, INDEXED_DB_QUEUE_PROBE_MAX_TO_READ)
            })
            : [...(await readStoredQueueEntries(
                db,
                this.#storeName,
                [...observations.values()].map((entry) => toKeyAsString(entry.key))
            )).values()];
        const reserved = new Map<Key, ResourceEntry>();
        const mutations: ComputedIndexedDbQueueMutation[] = [];
        for (const stored of candidates) {
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
        { typeIds, statusIds, reservationInput, observedEntries }: ResourceInboxReservationRequest
    ): Promise<Map<Key, ResourceEntry>> {
        this.#observer.observe({ owner: 'al-work', kind: 'work-reserve' });
        const { maxToReserve, maxAttempts } = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        );
        const observations = captureResourceEntryObservations(observedEntries);
        if (observations?.size === 0 || maxToReserve === 0) {
            return new Map();
        }
        const db = await this.#connection.open();
        const now = this.#now();
        const candidates = observations === undefined
            ? await readStoredQueueEntriesByTypesAndStatuses({
                db,
                storeName: this.#storeName,
                typeIds,
                statusIds,
                maxToReadPerCombination: maxToReserve
            })
            : [...(await readStoredQueueEntries(
                db,
                this.#storeName,
                [...observations.values()].map((entry) => toKeyAsString(entry.key))
            )).values()];
        const reserved = new Map<Key, ResourceEntry>();
        const mutations: ComputedIndexedDbQueueMutation[] = [];
        for (const stored of candidates) {
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
        this.#observer.observe({ owner: 'al-work', kind: 'work-reserve' });
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
        const now = this.#now();
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
        this.#observer.observe({ owner: 'al-work', kind: 'work-reserve' });
        const options = toResourceInboxFinalizationReservationOptions(input);
        if (typeIds.size === 0 || options.maxToReserve === 0) {
            return new Map();
        }
        const db = await this.#connection.open();
        const now = this.#now();
        const staleBefore = now.subtract({ milliseconds: options.staleAfterMs });
        // Read past maxToReserve so an exhausted (poison) generation cannot mask a valid sibling.
        const perTypeMaxToRead = Math.max(options.maxToReserve, INDEXED_DB_QUEUE_PROBE_MAX_TO_READ);
        const candidates = await readStoredQueueEntriesByTypesAndStatuses({
            db,
            storeName: this.#storeName,
            typeIds,
            statusIds: [EntityStatus.RESERVED],
            maxToReadPerCombination: perTypeMaxToRead
        });
        const reserved = new Map<Key, ResourceInboxFinalizationSelection>();
        const mutations: ComputedIndexedDbQueueMutation[] = [];
        for (const stored of candidates) {
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
        this.#observer.observe({ owner: 'al-work', kind: 'work-probe' });
        const options = toResourceInboxWorkAdvertisementOptions(workInput);
        const db = await this.#connection.open();
        const now = this.#now();
        const anyEntryToLock = await hasIndexedDbEntryToLock({
            newAndRetryCandidates: [
                ...await this.#readNewProbeEntries(db, typeIds),
                ...await this.#readDueRetryProbeEntries(db, typeIds, now)
            ],
            reservedCandidates: await this.#readReservedProbeEntries(db, typeIds),
            options,
            typeIds,
            now
        });

        this.cleanup();

        return anyEntryToLock;
    }

    async #readNewProbeEntries(
        db: IDBDatabase,
        typeIds: ReadonlySet<string>
    ): Promise<readonly StoredResourceEntry[]> {
        return await readStoredQueueEntriesByTypesAndStatuses({
            db,
            storeName: this.#storeName,
            typeIds,
            statusIds: [EntityStatus.NEW],
            maxToReadPerCombination: 1
        });
    }

    async #readDueRetryProbeEntries(
        db: IDBDatabase,
        typeIds: ReadonlySet<string>,
        now: Temporal.Instant
    ): Promise<readonly StoredResourceEntry[]> {
        // maxToScan = typeIds.size reads exactly the earliest due RETRY row per type, with no
        // cursor continuation: the fairness range's upper bound is the probe's due check.
        const dueByType = await readFairnessStoredQueueEntries({
            db,
            storeName: this.#storeName,
            indexName: INDEXED_DB_QUEUE_FAIRNESS_INDEX_NAME,
            typeIds: [...typeIds],
            overdueBeforeEpochMs: Number(now.epochMilliseconds),
            maxToScan: typeIds.size
        });
        return [...dueByType.values()].flat();
    }

    async #readReservedProbeEntries(
        db: IDBDatabase,
        typeIds: ReadonlySet<string>
    ): Promise<readonly StoredResourceEntry[]> {
        return await readStoredQueueEntriesByTypesAndStatuses({
            db,
            storeName: this.#storeName,
            typeIds,
            statusIds: [EntityStatus.RESERVED],
            maxToReadPerCombination: INDEXED_DB_QUEUE_PROBE_MAX_TO_READ
        });
    }

    /** The millisecond-truncated expiry index can front-run the precise instant by up to 1 ms. */
    async #readExpiredEntries(
        db: IDBDatabase,
        now: Temporal.Instant
    ): Promise<readonly StoredResourceEntry[]> {
        const candidates = await readExpiredStoredQueueEntries({
            db,
            storeName: this.#storeName,
            nowEpochMs: Number(now.epochMilliseconds),
            maxToRead: INDEXED_DB_QUEUE_CLEANUP_MAX_EXPIRED_TO_DELETE
        });
        return candidates.filter((stored) => isStoredQueueEntryExpired(stored, now));
    }

    async #write<Result>(
        db: IDBDatabase,
        computed: IndexedDbQueueComputedWrite<Result>
    ): Promise<Result> {
        if (computed.mutations.length === 0) {
            return computed.result;
        }
        if (
            !await writeComputedIndexedDbQueueMutations({
                db: db,
                storeName: this.#storeName,
                mutations: computed.mutations
            })
        ) {
            throw new IndexedDbQueueWriteConflictError('IndexedDB queue write conflicted');
        }
        return computed.result;
    }

    async getItem(key: Key): Promise<ResourceEntry | undefined> {
        this.#observer.observe({ owner: 'al-work', kind: 'work-read' });
        const db = await this.#connection.open();
        const keyString = toKeyAsString(key);
        const stored = await readStoredQueueEntry(db, this.#storeName, keyString);
        if (!stored) {
            return undefined;
        }
        const computed: IndexedDbQueueComputedWrite<ResourceEntry | undefined> =
            isStoredQueueEntryExpired(stored, this.#now())
                ? { mutations: [computeIndexedDbQueueDelete(stored)], result: undefined }
                : { mutations: [], result: decodeStoredResourceEntry(stored) };
        return await this.#write(db, computed);
    }

    async setItem(
        key: Key,
        value: ResourceEntry,
        _options: PersistenceSetItemOptions
    ): Promise<void> {
        this.#observer.observe({ owner: 'al-work', kind: 'work-write' });
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
        this.#observer.observe({ owner: 'al-work', kind: 'work-write' });
        const db = await this.#connection.open();
        await writeComputedIndexedDbQueueMutations({
            db: db,
            storeName: this.#storeName,
            mutations: [
                computeIndexedDbQueueUnconditionalDelete(toKeyAsString(key))
            ]
        });
    }

    async getAllKeys(): Promise<Key[]> {
        this.#observer.observe({ owner: 'al-work', kind: 'work-read' });
        const db = await this.#connection.open();
        // Unscoped by type or status: every other read narrows by an index, this one cannot, so
        // it reads the store directly instead of a single-caller store-module export for it.
        const transaction = db.transaction(this.#storeName, 'readonly');
        const rawValues = await readIndexedDbTransaction(
            transaction,
            async () => await readIndexedDbRequest(transaction.objectStore(this.#storeName).getAll())
        );
        const entries = rawValues.map(decodeStoredResourceEntryValue);
        const now = this.#now();
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

    /**
     * One bounded page per call: a returned count that reaches the per-run budget is the caller's
     * signal that more expired rows remain, so the bound belongs to the caller and not to a loop here.
     */
    async deleteExpired(): Promise<number> {
        this.#observer.observe({ owner: 'al-work', kind: 'work-cleanup' });
        const db = await this.#connection.open();
        const expired = await this.#readExpiredEntries(db, this.#now());
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

interface IndexedDbEntryToLockInput {
    readonly newAndRetryCandidates: readonly StoredResourceEntry[];
    readonly reservedCandidates: readonly StoredResourceEntry[];
    readonly options: ResourceInboxWorkAdvertisementOptions;
    readonly typeIds: ReadonlySet<string>;
    readonly now: Temporal.Instant;
}

async function hasIndexedDbEntryToLock(input: IndexedDbEntryToLockInput): Promise<boolean> {
    const { newAndRetryCandidates, reservedCandidates, options, typeIds, now } = input;
    const { maxAttempts, finalizationStaleAfterMs } = options;
    const isTimedOutEntryToLock = await RateLimiter.tryToExecuteOrDefault(
        options.checkTimeout,
        async () =>
            reservedCandidates.some((stored) =>
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
    const newAndRetryEntryToLock = newAndRetryCandidates.some((stored) =>
        isStoredQueueEntryReservable({
            stored,
            typeIds,
            statusIds: NEW_AND_RETRY_STATUSES,
            now,
            maxAttempts
        })
    );
    const finalizationEntryToLock = await RateLimiter.tryToExecuteOrDefault(
        options.checkFinalization,
        async () =>
            hasIndexedDbFinalizationWork({
                entries: reservedCandidates,
                typeIds,
                now,
                maxAttempts,
                finalizationStaleAfterMs
            }),
        false
    );
    return newAndRetryEntryToLock || isTimedOutEntryToLock || finalizationEntryToLock;
}

interface IndexedDbFinalizationWorkInput {
    readonly entries: readonly StoredResourceEntry[];
    readonly typeIds: ReadonlySet<string>;
    readonly now: Temporal.Instant;
    readonly maxAttempts: number;
    readonly finalizationStaleAfterMs: number;
}

function hasIndexedDbFinalizationWork(input: IndexedDbFinalizationWorkInput): boolean {
    if (!input.typeIds.has(EnqueuedType.APP_INBOX)) {
        return false;
    }
    const staleBefore = input.now.subtract({ milliseconds: input.finalizationStaleAfterMs });
    return input.entries.some((stored) =>
        selectRetryExhaustionDueTimestamp({
            typeIds: new Set([EnqueuedType.APP_INBOX]),
            stored,
            processingAttempts: input.maxAttempts,
            now: input.now,
            staleBefore
        }) !== undefined
    );
}
