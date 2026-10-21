import { Temporal } from '@js-temporal/polyfill';

import { EnqueuedType } from '../api/api-config.ts';
import type { Unsubscribe } from '../cache/RepositoryInterfaces.ts';
import { SynchronousNotifications } from '../cache/synchronous-notifications.ts';
import type { PersistenceSetItemOptions } from '../persistence/PersistenceProvider.ts';
import { RateLimiter } from '../resilience/Resilience.ts';
import {
    computeResourceInboxRelease,
    toValidatedResourceInboxReleases
} from './compute-resource-inbox-release.ts';
import { hasAdvertisedDequeueWork, type DequeueController } from './dequeue/dequeue-controller.ts';
import { InMemoryQueueWorkIndex } from './in-memory-queue-work-index.ts';
import { matchesQueueBoxCompletedRetention, type QueueBoxCompletedRetention } from './queue-box-completed-retention.ts';
import {
    isIdempotentHandlerFinalizedRelease,
    QueueBoxResourceEntryRepository,
    ResourceInboxFairnessReservationInput,
    ResourceInboxFairnessSelection,
    ResourceInboxFinalizationReservationOptions,
    ResourceInboxFinalizationSelection,
    ResourceInboxLostReservationError,
    ResourceInboxRelease,
    ResourceInboxWorkAdvertisementOptions,
    ResourceInboxWorkPage,
    toResourceInboxFairnessReservationOptions,
    toResourceInboxFinalizationReservationOptions,
    toResourceInboxReservationOptions,
    toResourceInboxWorkAdvertisementOptions,
    type ResourceInboxReservationObservationRequest,
    type ResourceInboxReservationObservationResult,
    type ResourceInboxReservationRequest,
    type ResourceInboxTimeoutReservationRequest
} from './queue-box-types.ts';
import {
    captureResourceEntryObservations,
    hasSameResourceEntryValue,
    resolveResourceEntryObservation,
    resolveResourceEntryObservedWrites,
    toResourceEntrySnapshot
} from './resource-entry-observations.ts';
import {
    resolveResourceInboxClaimOrder,
    toCreationOrderedEntries
} from './resource-inbox/resource-inbox-claim-order.ts';
import { ResourceInboxClaimedContexts } from './resource-inbox/resource-inbox-claimed-contexts.ts';
import { toUnavailableReservationObservation } from './resource-inbox/resource-inbox-reservation-observation.ts';
import { ResourceInboxResilience } from './resource-inbox/resource-inbox-resilience.ts';
import {
    COMPLETED_STATUSES,
    EntityStatus,
    isExpiredResourceEntry,
    Key,
    ResourceEntry,
    ResourceEntryKeyString,
    toKeyAsString,
    toResourceEntryKey
} from './ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from './ResourceInboxRetryPolicy.ts';

/** The work index's largest page: a sweep reads every page it needs, this many keys at a time. */
const INDEX_PAGE_SIZE = 256;

export namespace InMemoryQueueBox {
    export interface ReservationRead {
        readonly entry: ResourceEntry;
        readonly typeIds: ReadonlySet<string>;
        readonly statusIds: ReadonlySet<EntityStatus>;
        readonly maxAttempts: number;
        readonly now: Temporal.Instant;
    }

    export interface ComputedWrite {
        readonly expected: ResourceEntry | undefined;
        readonly entry: ResourceEntry;
    }

    export interface ComputedGuard {
        readonly key: Key;
        readonly expected: ResourceEntry | undefined;
    }

    export type ComputedOperation = ComputedWrite | ComputedGuard;
}

export class InMemoryQueueBox implements QueueBoxResourceEntryRepository {
    private readonly data: Map<ResourceEntryKeyString, ResourceEntry>;
    private readonly now: () => Temporal.Instant;
    private workIndex = new InMemoryQueueWorkIndex();
    private readonly changes = new SynchronousNotifications<ResourceEntryKeyString>((error) =>
        console.error('Queue change observer failed', error)
    );
    private completedRetention: QueueBoxCompletedRetention = { typeIds: [], topicIds: [] };

    private readonly cleanupRateLimiter: RateLimiter = RateLimiter.init(
        ResourceInboxResilience.RATE_LIMITER_RESERVED_TIMEOUT_SLIDING_WINDOW_DURATION_MS,
        ResourceInboxResilience.MAX_NUM_CLEANUP_IN_WINDOW
    );

    constructor(
        input: Map<Key, ResourceEntry> = new Map<Key, ResourceEntry>(),
        now: () => Temporal.Instant = Temporal.Now.instant
    ) {
        this.now = now;
        this.data = new Map<ResourceEntryKeyString, ResourceEntry>();

        for (const [key, entry] of input) {
            this.storeEntry(toKeyAsString(key), toResourceEntrySnapshot(entry));
        }
    }

    async readWorkPage(request: ResourceInboxWorkPage.Request): Promise<ResourceInboxWorkPage> {
        const page = this.workIndex.read(request);
        return {
            entries: page.keys.map((key) => toResourceEntrySnapshot(this.data.get(key)!)),
            nextCursor: page.nextCursor
        };
    }

    async readWorkPages(requests: readonly ResourceInboxWorkPage.Request[]): Promise<readonly ResourceInboxWorkPage[]> {
        return await Promise.all(requests.map((request) => this.readWorkPage(request)));
    }

    /** Names, in the turn it happens, every key a write, reservation, release, expiry or cleanup changes. */
    onChangeDo(listener: (key: ResourceEntryKeyString) => void): Unsubscribe {
        return this.changes.subscribe(listener);
    }

    /** The entry as held now, expired or not; unlike `getItem` it removes nothing. */
    peek(key: ResourceEntryKeyString): ResourceEntry | undefined {
        const entry = this.data.get(key);
        return entry === undefined ? undefined : toResourceEntrySnapshot(entry);
    }

    /** Every key held now, expired or not; unlike `getAllKeys` it removes nothing. */
    peekKeys(): readonly ResourceEntryKeyString[] {
        return [...this.data.keys()];
    }

    private storeEntry(key: string, entry: ResourceEntry): void {
        this.workIndex.replace(key, this.data.get(key), entry);
        this.data.set(key, entry);
        this.notifyChange(key);
    }

    private removeEntry(key: string): void {
        const existing = this.data.get(key);
        if (existing === undefined) {
            return;
        }
        this.workIndex.remove(key, existing);
        this.data.delete(key);
        this.notifyChange(key);
    }

    private notifyChange(key: ResourceEntryKeyString): void {
        this.changes.capture([key]).publish();
    }

    async cleanupAsync(): Promise<boolean> {
        return RateLimiter.tryToExecuteOrDefault(
            this.cleanupRateLimiter,
            async () => this.cleanup(),
            false
        );
    }

    /** Install the adopting owner's policy before exposing this queue to its workers. */
    retainCompletedUntilExpiry(selection: QueueBoxCompletedRetention): void {
        this.completedRetention = {
            typeIds: [...new Set([...this.completedRetention.typeIds, ...selection.typeIds])],
            topicIds: [...new Set([...this.completedRetention.topicIds, ...selection.topicIds])]
        };
    }

    cleanup(): boolean {
        const now = this.now();
        const keysToRemove: ResourceEntryKeyString[] = [];

        for (const [key, entry] of this.data) {
            if (
                isExpiredResourceEntry(entry, now) ||
                (COMPLETED_STATUSES.has(entry.status) &&
                    !matchesQueueBoxCompletedRetention(entry, this.completedRetention))
            ) {
                keysToRemove.push(key);
            }
        }

        this.applyEntries(keysToRemove.map((key) => [key, undefined] as const)).publish();

        return keysToRemove.length > 0;
    }

    async enqueue(resourceEntry: ResourceEntry): Promise<ResourceEntry | undefined> {
        const previous = this.data.get(toKeyAsString(resourceEntry.key));
        this.storeEntry(toKeyAsString(resourceEntry.key), toResourceEntrySnapshot(resourceEntry));

        return previous === undefined ? undefined : toResourceEntrySnapshot(previous);
    }

    async replaceIfObserved(
        expected: ResourceEntry,
        replacement: ResourceEntry
    ): Promise<ResourceEntry | null> {
        return this.writeIfAllObserved([{ expected, entry: replacement }])
            ? toResourceEntrySnapshot(replacement)
            : null;
    }

    async enqueueIfAbsent(resourceEntry: ResourceEntry): Promise<ResourceEntry> {
        if (this.writeIfAllObserved([{ expected: undefined, entry: resourceEntry }])) {
            return toResourceEntrySnapshot(resourceEntry);
        }
        return toResourceEntrySnapshot(this.data.get(toKeyAsString(resourceEntry.key))!);
    }

    /** Standalone guarded writes publish synchronously after the complete queue/index batch. */
    writeIfAllObserved(writes: readonly InMemoryQueueBox.ComputedOperation[]): boolean {
        const publication = this.writeObservedBatch(writes);
        publication?.publish();
        return publication !== null;
    }

    /**
     * Validates and applies a complete queue/index batch without invoking observers. A joint memory
     * owner must finish its already-computed state and then publish this receipt in the same turn.
     */
    writeObservedBatch(
        writes: readonly InMemoryQueueBox.ComputedOperation[]
    ): SynchronousNotifications.Publication | null {
        const observedAt = this.now();
        const observations = writes.map((write) => {
            const key = toKeyAsString('entry' in write ? write.entry.key : write.key);
            return {
                key,
                expected: write.expected,
                entry: 'entry' in write ? toResourceEntrySnapshot(write.entry) : undefined,
                existing: this.data.get(key)
            };
        });
        const validated = resolveResourceEntryObservedWrites(observations, observedAt);
        if (validated.left === 'conflict') {
            return null;
        }
        if (validated.left) {
            throw validated.left;
        }
        return this.applyEntries(
            validated.right!.flatMap((write) => write.entry === undefined ? [] : [[write.key, write.entry] as const])
        );
    }

    /** Checkpoint restoration keeps each live queue value and defers publication to its joint owner. */
    loadIfAbsent(entries: readonly ResourceEntry[]): SynchronousNotifications.Publication {
        const observedAt = this.now();
        const replacements = new Map<string, ResourceEntry>();
        for (const entry of entries) {
            const key = toKeyAsString(entry.key);
            const existing = this.data.get(key);
            if (!replacements.has(key) && (existing === undefined || isExpiredResourceEntry(existing, observedAt))) {
                replacements.set(key, toResourceEntrySnapshot(entry));
            }
        }
        return this.applyEntries([...replacements]);
    }

    private applyEntries(
        entries: readonly (readonly [string, ResourceEntry | undefined])[]
    ): SynchronousNotifications.Publication {
        const workIndex = this.workIndex.clone();
        for (const [key, entry] of entries) {
            if (entry === undefined) {
                workIndex.remove(key, this.data.get(key));
            }
            else {
                workIndex.replace(key, this.data.get(key), entry);
            }
        }
        const publication = this.changes.capture(entries.map(([key]) => key));
        for (const [key, entry] of entries) {
            if (entry === undefined) {
                this.data.delete(key);
            }
            else {
                this.data.set(key, entry);
            }
        }
        this.workIndex = workIndex;
        return publication;
    }

    async releaseEntries(releases: readonly ResourceInboxRelease[]): Promise<Map<Key, ResourceEntry>> {
        const releasedAt = this.now();
        const reserved = toValidatedResourceInboxReleases(releases).map((release) => ({
            current: this.readReservedEntryForRelease(release, releasedAt),
            disposition: release.disposition
        }));
        const released = new Map<Key, ResourceEntry>();
        const replacements: (readonly [string, ResourceEntry])[] = [];

        for (const { current, disposition } of reserved) {
            if (current.status !== EntityStatus.RESERVED) {
                const snapshot = toResourceEntrySnapshot(current);
                released.set(snapshot.key, snapshot);
                continue;
            }
            const updated = computeResourceInboxRelease(current, disposition, releasedAt);
            replacements.push([toKeyAsString(current.key), updated]);
            const snapshot = toResourceEntrySnapshot(updated);
            released.set(snapshot.key, snapshot);
        }

        this.applyEntries(replacements).publish();
        return released;
    }

    /** The live row a release may write, or the lost reservation the whole batch rolls back on. */
    private readReservedEntryForRelease(
        release: ResourceInboxRelease,
        releasedAt: Temporal.Instant
    ): ResourceEntry {
        const current = this.data.get(toKeyAsString(release.entry.key));
        if (
            !current ||
            (
                (
                    isExpiredResourceEntry(current, releasedAt) ||
                    current.status !== EntityStatus.RESERVED ||
                    !hasSameResourceEntryValue(current, release.entry)
                ) &&
                !isIdempotentHandlerFinalizedRelease({
                    current,
                    reserved: release.entry,
                    disposition: release.disposition,
                    observedAt: releasedAt
                })
            )
        ) {
            throw new ResourceInboxLostReservationError(
                release.entry.key,
                release.entry.dequeueAudit.attempts
            );
        }
        return current;
    }

    async reserveTimeoutEntries(
        { typeIds, reservationInput, timeSinceStartTs, observedEntries, excludedContextIds }:
            ResourceInboxTimeoutReservationRequest
    ): Promise<Map<Key, ResourceEntry>> {
        const { maxToReserve, maxAttempts } = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        );
        const timedOut = new Map<Key, ResourceEntry>();
        const observations = captureResourceEntryObservations(observedEntries);
        const now = this.now();

        for (const candidate of observations?.values() ?? this.data.values()) {
            if (timedOut.size >= maxToReserve) {
                break;
            }
            const key = toKeyAsString(candidate.key);
            const entry = this.data.get(key);
            if (entry === undefined || resolveResourceEntryObservation(entry, observations).left) {
                continue;
            }

            if (
                entry.dequeueAudit.attempts < maxAttempts && typeIds.has(entry.typeId) &&
                !isExpiredResourceEntry(entry, now) &&
                isReservedEntryStartedBefore(entry, now.subtract(timeSinceStartTs)) &&
                excludedContextIds?.has(entry.key.contextId) !== true
            ) {
                const updated = computeReservedResourceEntry(entry, now);
                this.storeEntry(key, updated);
                timedOut.set(toResourceEntryKey(key), toResourceEntrySnapshot(updated));
            }
        }

        return timedOut;
    }

    reserveEntries(
        request: ResourceInboxReservationObservationRequest
    ): Promise<ResourceInboxReservationObservationResult>;
    reserveEntries(request: ResourceInboxReservationRequest): Promise<Map<Key, ResourceEntry>>;
    async reserveEntries(
        request: ResourceInboxReservationRequest | ResourceInboxReservationObservationRequest
    ): Promise<Map<Key, ResourceEntry> | ResourceInboxReservationObservationResult> {
        const { typeIds, statusIds, reservationInput, observedEntries, contextClaim } = request;
        const { maxToReserve, maxAttempts } = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        );
        const reserved = new Map<Key, ResourceEntry>();
        const observations = captureResourceEntryObservations(observedEntries);
        const now = this.now();
        const claimedContexts = contextClaim === undefined ? undefined : new ResourceInboxClaimedContexts(contextClaim);

        for (const candidate of observations?.values() ?? this.getClaimCandidates(typeIds, statusIds)) {
            if (reserved.size >= maxToReserve) {
                break;
            }
            const key = toKeyAsString(candidate.key);
            const entry = this.data.get(key);
            if (entry === undefined || resolveResourceEntryObservation(entry, observations).left) {
                continue;
            }

            if (!isInMemoryQueueEntryReservable({ entry, typeIds, statusIds, maxAttempts, now })) {
                continue;
            }
            if (claimedContexts?.admits(entry.key) === false) {
                continue;
            }
            claimedContexts?.record(entry.key);
            const updated = computeReservedResourceEntry(entry, now);
            this.storeEntry(key, updated);
            reserved.set(toResourceEntryKey(key), toResourceEntrySnapshot(updated));
        }

        return 'reservationObservation' in request
            ? {
                entries: reserved,
                observations: [...reserved.values()].map((entry) =>
                    toUnavailableReservationObservation(entry, 'unsupported-backend')
                )
            }
            : reserved;
    }

    async reserveOverdueRetryEntries(
        typeIds: Set<string>,
        overdueBeforeEpochMs: number,
        reservationInput: ResourceInboxFairnessReservationInput
    ): Promise<Map<Key, ResourceInboxFairnessSelection>> {
        const { maxToReserve, maxAttempts, excludedContextIds } = toResourceInboxFairnessReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        );
        if (typeIds.size === 0 || maxToReserve <= 0) {
            return new Map();
        }

        const overdueBefore = Temporal.Instant.fromEpochMilliseconds(overdueBeforeEpochMs);
        const now = this.now();
        const candidates = [...this.data.entries()]
            .filter(([, entry]) =>
                !isExpiredResourceEntry(entry, now) &&
                typeIds.has(entry.typeId) &&
                entry.status === EntityStatus.RETRY &&
                entry.dequeueAudit.attempts < maxAttempts &&
                entry.dequeueAudit.nextTs !== undefined &&
                Temporal.Instant.compare(entry.dequeueAudit.nextTs, overdueBefore) <= 0 &&
                excludedContextIds?.has(entry.key.contextId) !== true
            )
            .sort(([leftKey, left], [rightKey, right]) => {
                const dueOrder = Temporal.Instant.compare(
                    left.dequeueAudit.nextTs!,
                    right.dequeueAudit.nextTs!
                );
                return dueOrder !== 0 ? dueOrder : leftKey.localeCompare(rightKey);
            })
            .slice(0, maxToReserve);
        const reserved = new Map<Key, ResourceInboxFairnessSelection>();
        const replacements: (readonly [string, ResourceEntry])[] = [];

        for (const [key, entry] of candidates) {
            const selectedNextTs = entry.dequeueAudit.nextTs;
            const updated = computeReservedResourceEntry(entry, now);
            replacements.push([key, updated]);
            reserved.set(toResourceEntryKey(key), {
                entry: toResourceEntrySnapshot(updated),
                selectedDueTs: selectedNextTs!
            });
        }

        this.applyEntries(replacements).publish();
        return reserved;
    }

    async reserveRetryExhaustionFinalizations(
        typeIds: Set<string>,
        input: ResourceInboxFinalizationReservationOptions
    ): Promise<Map<Key, ResourceInboxFinalizationSelection>> {
        const options = toResourceInboxFinalizationReservationOptions(input);
        if (typeIds.size === 0 || options.maxToReserve === 0) {
            return new Map();
        }
        const now = this.now();
        const candidates: [ResourceEntryKeyString, ResourceEntry][] = [];
        for (const candidate of this.getRetryExhaustionCandidates(typeIds, options, now)) {
            if (candidates.length >= options.maxToReserve) {
                break;
            }
            candidates.push(candidate);
        }
        const reserved = new Map<Key, ResourceInboxFinalizationSelection>();
        const replacements: (readonly [string, ResourceEntry])[] = [];
        for (const [key, entry] of candidates) {
            const selectedDueTs = entry.dequeueAudit.startTs!;
            const updated = computeReservedResourceEntry(entry, now);
            replacements.push([key, updated]);
            const snapshot = toResourceEntrySnapshot(updated);
            reserved.set(snapshot.key, { entry: snapshot, selectedDueTs });
        }
        this.applyEntries(replacements).publish();
        return reserved;
    }

    async readWorkAdvertisement(
        typeIds: Set<string>,
        workInput: ResourceInboxWorkAdvertisementOptions
    ): Promise<DequeueController.WorkAdvertisement> {
        const { maxAttempts, finalizationStaleAfterMs, reservationLeaseMs, staleDueThresholdMs } =
            toResourceInboxWorkAdvertisementOptions(workInput);
        const now = this.now();

        this.cleanupAsync()
            .catch((e) => {
                console.error('Failed to cleanup entries', e);
                return false;
            });

        return {
            FINALIZATION: this.hasRetryExhaustionFinalization(typeIds, maxAttempts, finalizationStaleAfterMs),
            NEW: this.hasEntry(typeIds, maxAttempts, (entry) => isNewEntryDue(entry, now)),
            RETRY: this.hasEntry(typeIds, maxAttempts, (entry) => isRetryEntryDueBefore(entry, now)),
            FAIRNESS: this.hasEntry(
                typeIds,
                maxAttempts,
                (entry) => isRetryEntryDueBefore(entry, now.subtract({ milliseconds: staleDueThresholdMs }))
            ),
            TIMEOUT: this.hasEntry(
                typeIds,
                maxAttempts,
                (entry) => isReservedEntryStartedBefore(entry, now.subtract({ milliseconds: reservationLeaseMs }))
            )
        };
    }

    async isAnyEntryToLock(
        typeIds: Set<string>,
        workInput: ResourceInboxWorkAdvertisementOptions
    ): Promise<boolean> {
        return hasAdvertisedDequeueWork(await this.readWorkAdvertisement(typeIds, workInput));
    }

    private hasRetryExhaustionFinalization(
        typeIds: Set<string>,
        processingAttempts: number,
        staleAfterMs: number
    ): boolean {
        if (!typeIds.has(EnqueuedType.APP_INBOX)) {
            return false;
        }
        const candidates = this.getRetryExhaustionCandidates(
            new Set([EnqueuedType.APP_INBOX]),
            { processingAttempts, staleAfterMs },
            this.now()
        );
        return candidates.next().done === false;
    }

    /**
     * The live stale exhausted reservations of these types, lazily, read through the work index: a sweep visits
     * the RESERVED rows alone, never the completed rows an owner retains until they expire.
     */
    private *getRetryExhaustionCandidates(
        typeIds: ReadonlySet<string>,
        criteria: Pick<ResourceInboxFinalizationReservationOptions, 'processingAttempts' | 'staleAfterMs'>,
        now: Temporal.Instant
    ): Generator<[ResourceEntryKeyString, ResourceEntry]> {
        const staleBefore = now.subtract({ milliseconds: criteria.staleAfterMs });
        for (const [key, entry] of this.getIndexedEntries(typeIds, EntityStatus.RESERVED)) {
            if (
                !isExpiredResourceEntry(entry, now) &&
                entry.dequeueAudit.attempts >= criteria.processingAttempts &&
                entry.dequeueAudit.attempts < Number.MAX_SAFE_INTEGER &&
                entry.dequeueAudit.startTs !== undefined &&
                Temporal.Instant.compare(entry.dequeueAudit.startTs, staleBefore) <= 0
            ) {
                yield [key, entry];
            }
        }
    }

    /**
     * The rows a claim looks at, in its claim order; creation ties keep insertion order, so a row stored early under an
     * old key does not go ahead of older work. A due-order claim keeps insertion order.
     */
    private getClaimCandidates(
        typeIds: ReadonlySet<string>,
        statusIds: ReadonlySet<EntityStatus>
    ): Iterable<ResourceEntry> {
        if (resolveResourceInboxClaimOrder(statusIds) === 'due') {
            return this.data.values();
        }
        return toCreationOrderedEntries(
            [...this.data.values()].filter((entry) => typeIds.has(entry.typeId) && statusIds.has(entry.status)),
            (entry) => entry.audit.createdTs
        );
    }

    private *getIndexedEntries(
        typeIds: ReadonlySet<string>,
        status: EntityStatus
    ): Generator<[ResourceEntryKeyString, ResourceEntry]> {
        for (const typeId of typeIds) {
            let cursor: ResourceInboxWorkPage.Cursor | null = null;
            do {
                const page = this.workIndex.read({ typeId, status, maxToRead: INDEX_PAGE_SIZE, cursor });
                for (const key of page.keys) {
                    const entry = this.data.get(key);
                    if (entry !== undefined) {
                        yield [key, entry];
                    }
                }
                cursor = page.nextCursor;
            }
            while (cursor !== null);
        }
    }

    /** The first live row of these types below the attempt budget that the lane's predicate accepts. */
    private hasEntry(
        typeIds: Set<string>,
        maxAttempts: number,
        isCandidate: (entry: ResourceEntry) => boolean
    ): boolean {
        const now = this.now();
        for (const entry of this.data.values()) {
            if (
                typeIds.has(entry.typeId) && !isExpiredResourceEntry(entry, now) &&
                entry.dequeueAudit.attempts < maxAttempts && isCandidate(entry)
            ) {
                return true;
            }
        }
        return false;
    }

    async getItem(key: Key): Promise<ResourceEntry | undefined> {
        const entry = this.data.get(toKeyAsString(key));
        if (!entry) {
            return undefined;
        }

        if (isExpiredResourceEntry(entry, this.now())) {
            this.removeEntry(toKeyAsString(key));
            return undefined;
        }

        return toResourceEntrySnapshot(entry);
    }

    async setItem(
        key: Key,
        value: ResourceEntry,
        _options: PersistenceSetItemOptions
    ): Promise<void> {
        this.storeEntry(
            toKeyAsString(key),
            toResourceEntrySnapshot({
                ...value,
                key
            })
        );
    }

    async removeItem(key: Key): Promise<void> {
        this.removeEntry(toKeyAsString(key));
    }

    async getAllKeys(): Promise<Key[]> {
        await this.deleteExpired();
        return Array.from(this.data.keys()).map(toResourceEntryKey);
    }

    async deleteExpired(): Promise<number> {
        const now = this.now();
        let removed = 0;

        for (const [key, entry] of this.data.entries()) {
            if (!isExpiredResourceEntry(entry, now)) {
                continue;
            }

            this.removeEntry(key);
            removed += 1;
        }

        return removed;
    }
}

function computeReservedResourceEntry(entry: ResourceEntry, now: Temporal.Instant): ResourceEntry {
    return {
        ...entry,
        status: EntityStatus.RESERVED,
        dequeueAudit: {
            startTs: now,
            endTs: undefined,
            nextTs: undefined,
            attempts: entry.dequeueAudit.attempts + 1
        }
    };
}

function isNewEntryDue(entry: ResourceEntry, now: Temporal.Instant): boolean {
    return entry.status === EntityStatus.NEW &&
        (entry.dequeueAudit.nextTs === undefined || Temporal.Instant.compare(entry.dequeueAudit.nextTs, now) <= 0);
}

function isRetryEntryDueBefore(entry: ResourceEntry, dueBefore: Temporal.Instant): boolean {
    return entry.status === EntityStatus.RETRY && entry.dequeueAudit.nextTs !== undefined &&
        Temporal.Instant.compare(entry.dequeueAudit.nextTs, dueBefore) <= 0;
}

function isReservedEntryStartedBefore(entry: ResourceEntry, startedBefore: Temporal.Instant): boolean {
    return entry.status === EntityStatus.RESERVED && entry.dequeueAudit.startTs !== undefined &&
        Temporal.Instant.compare(entry.dequeueAudit.startTs, startedBefore) <= 0;
}

function isInMemoryQueueEntryReservable(read: InMemoryQueueBox.ReservationRead): boolean {
    const { entry, now } = read;
    return read.typeIds.has(entry.typeId) && read.statusIds.has(entry.status) &&
        !isExpiredResourceEntry(entry, now) && entry.status !== EntityStatus.FAILED &&
        entry.dequeueAudit.attempts < read.maxAttempts &&
        (entry.dequeueAudit.nextTs === undefined || Temporal.Instant.compare(now, entry.dequeueAudit.nextTs) >= 0);
}
