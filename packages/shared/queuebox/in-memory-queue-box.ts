import { Temporal } from '@js-temporal/polyfill';

import { EnqueuedType } from '../api/api-config.ts';
import type { PersistenceSetItemOptions } from '../persistence/PersistenceProvider.ts';
import { Either } from '../resilience/Either.ts';
import { RateLimiter } from '../resilience/Resilience.ts';
import {
    computeResourceInboxRelease,
    validateResourceInboxReleaseDisposition
} from './compute-resource-inbox-release.ts';
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
    toResourceEntrySnapshot,
    validateResourceEntryObservation
} from './resource-entry-observations.ts';
import { ResourceInboxResilience } from './resource-inbox/resource-inbox-resilience.ts';
import {
    COMPLETED_STATUSES,
    EntityStatus,
    isExpiredResourceEntry,
    Key,
    NEW_AND_RETRY_STATUSES,
    ResourceEntry,
    ResourceEntryKeyString,
    TIMEOUT_ON_NON_RESPONSIVE_ENTRY,
    toKeyAsString,
    toResourceEntryKey
} from './ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from './ResourceInboxRetryPolicy.ts';

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
    private readonly workIndex = new InMemoryQueueWorkIndex();
    private completedRetention: QueueBoxCompletedRetention = { typeIds: [], topicIds: [] };

    private readonly cleanupRateLimiter: RateLimiter = RateLimiter.init(
        ResourceInboxResilience.RATE_LIMITER_RESERVED_TIMEOUT_SLIDING_WINDOW_DURATION_MS,
        ResourceInboxResilience.MAX_NUM_IS_ENTRY_CHECK
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

    private storeEntry(key: string, entry: ResourceEntry): void {
        this.workIndex.replace(key, this.data.get(key), entry);
        this.data.set(key, entry);
    }

    private removeEntry(key: string): void {
        this.workIndex.remove(key, this.data.get(key));
        this.data.delete(key);
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
        const keysToRemove: ResourceEntryKeyString[] = [];

        for (const [key, entry] of this.data) {
            if (
                isExpiredResourceEntry(entry) ||
                (COMPLETED_STATUSES.has(entry.status) &&
                    !matchesQueueBoxCompletedRetention(entry, this.completedRetention))
            ) {
                keysToRemove.push(key);
            }
        }

        for (const key of keysToRemove) {
            this.removeEntry(key);
        }

        if (keysToRemove.length > 0) {
            console.log('Removed entries: ', keysToRemove.length);
        }

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

    /** The caller can commit its other in-memory state immediately after this synchronous batch. */
    writeIfAllObserved(writes: readonly InMemoryQueueBox.ComputedOperation[]): boolean {
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
        const validated = validateInMemoryQueueWrites(observations, observedAt);
        if (validated.left === 'conflict') {
            return false;
        }
        if (validated.left) {
            throw validated.left;
        }
        for (const write of validated.right!) {
            if (write.entry !== undefined) {
                this.storeEntry(write.key, write.entry);
            }
        }
        return true;
    }

    async tryWriteIfAbsentOrReplaceExpired(
        resourceEntry: ResourceEntry
    ): Promise<ResourceEntry | null> {
        return this.writeIfAllObserved([{ expected: undefined, entry: resourceEntry }])
            ? toResourceEntrySnapshot(resourceEntry)
            : null;
    }

    async releaseEntries(
        resources: ResourceEntry[],
        releaseInput: ResourceInboxReleaseDisposition
    ): Promise<Map<Key, ResourceEntry>> {
        const disposition = validateResourceInboxReleaseDisposition(releaseInput).fold(
            (error) => {
                throw error;
            },
            (value) => value
        );
        const releasedAt = this.now();
        const currentEntries = resources.map((resource) => {
            const current = this.data.get(toKeyAsString(resource.key));
            if (
                !current ||
                (
                    (
                        isExpiredResourceEntry(current, releasedAt) ||
                        current.status !== EntityStatus.RESERVED ||
                        !hasSameResourceEntryValue(current, resource)
                    ) &&
                    !isIdempotentHandlerFinalizedRelease({
                        current,
                        reserved: resource,
                        disposition,
                        observedAt: releasedAt
                    })
                )
            ) {
                throw new ResourceInboxLostReservationError(
                    resource.key,
                    resource.dequeueAudit.attempts
                );
            }
            return current;
        });
        const released = new Map<Key, ResourceEntry>();

        for (const current of currentEntries) {
            if (current.status !== EntityStatus.RESERVED) {
                const snapshot = toResourceEntrySnapshot(current);
                released.set(snapshot.key, snapshot);
                continue;
            }
            const updated = computeResourceInboxRelease(current, disposition, releasedAt);
            this.storeEntry(toKeyAsString(current.key), updated);
            const snapshot = toResourceEntrySnapshot(updated);
            released.set(snapshot.key, snapshot);
        }

        return released;
    }

    async reserveTimeoutEntries(
        { typeIds, reservationInput, timeSinceStartTs, observedEntries }: ResourceInboxTimeoutReservationRequest
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
            if (entry === undefined || validateResourceEntryObservation(entry, observations).left) {
                continue;
            }

            if (
                entry.dequeueAudit.attempts < maxAttempts &&
                this.isReservedEntryTimedOut(typeIds, entry, timeSinceStartTs)
            ) {
                const updated = computeReservedResourceEntry(entry, now);
                this.storeEntry(key, updated);
                timedOut.set(toResourceEntryKey(key), toResourceEntrySnapshot(updated));
            }
        }

        return timedOut;
    }

    async reserveEntries(
        { typeIds, statusIds, reservationInput, observedEntries }: ResourceInboxReservationRequest
    ): Promise<Map<Key, ResourceEntry>> {
        const { maxToReserve, maxAttempts } = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        );
        const reserved = new Map<Key, ResourceEntry>();
        const observations = captureResourceEntryObservations(observedEntries);
        const now = this.now();

        for (const candidate of observations?.values() ?? this.data.values()) {
            if (reserved.size >= maxToReserve) {
                break;
            }
            const key = toKeyAsString(candidate.key);
            const entry = this.data.get(key);
            if (entry === undefined || validateResourceEntryObservation(entry, observations).left) {
                continue;
            }

            if (!isInMemoryQueueEntryReservable({ entry, typeIds, statusIds, maxAttempts, now })) {
                continue;
            }
            const updated = computeReservedResourceEntry(entry, now);
            this.storeEntry(key, updated);
            reserved.set(toResourceEntryKey(key), toResourceEntrySnapshot(updated));
        }

        return reserved;
    }

    async reserveOverdueRetryEntries(
        typeIds: Set<string>,
        overdueBeforeEpochMs: number,
        reservationInput: ResourceInboxFairnessReservationInput
    ): Promise<Map<Key, ResourceInboxFairnessSelection>> {
        const { maxToReserve, maxAttempts } = toResourceInboxFairnessReservationOptions(
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
                Temporal.Instant.compare(entry.dequeueAudit.nextTs, overdueBefore) <= 0
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

        for (const [key, entry] of candidates) {
            const selectedNextTs = entry.dequeueAudit.nextTs;
            const updated = computeReservedResourceEntry(entry, now);
            this.storeEntry(key, updated);
            reserved.set(toResourceEntryKey(key), {
                entry: toResourceEntrySnapshot(updated),
                selectedDueTs: selectedNextTs!
            });
        }

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
        const staleBefore = now.subtract({ milliseconds: options.staleAfterMs });
        const candidates = [...this.data.entries()].filter(([, entry]) =>
            typeIds.has(entry.typeId) &&
            entry.status === EntityStatus.RESERVED &&
            !isExpiredResourceEntry(entry, now) &&
            entry.dequeueAudit.attempts >= options.processingAttempts &&
            entry.dequeueAudit.attempts < Number.MAX_SAFE_INTEGER &&
            entry.dequeueAudit.startTs !== undefined &&
            Temporal.Instant.compare(entry.dequeueAudit.startTs, staleBefore) <= 0
        ).slice(0, options.maxToReserve);
        const reserved = new Map<Key, ResourceInboxFinalizationSelection>();
        for (const [key, entry] of candidates) {
            const selectedDueTs = entry.dequeueAudit.startTs!;
            const updated = computeReservedResourceEntry(entry, now);
            this.storeEntry(key, updated);
            const snapshot = toResourceEntrySnapshot(updated);
            reserved.set(snapshot.key, { entry: snapshot, selectedDueTs });
        }
        return reserved;
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
                this.isAnyReservedEntryTimedOut(
                    typeIds,
                    TIMEOUT_ON_NON_RESPONSIVE_ENTRY,
                    maxAttempts
                ),
            false
        );

        const newAndRetryEntryToLock = this.isAnyToLock(
            typeIds,
            NEW_AND_RETRY_STATUSES,
            maxAttempts
        );
        const finalizationEntryToLock = await RateLimiter.tryToExecuteOrDefault(
            checkFinalization,
            async () =>
                this.hasRetryExhaustionFinalization(
                    typeIds,
                    maxAttempts,
                    finalizationStaleAfterMs
                ),
            false
        );

        this.cleanupAsync()
            .catch((e) => {
                console.error('Failed to cleanup entries', e);
                return false;
            });

        return newAndRetryEntryToLock || isTimedOutEntryToLock || finalizationEntryToLock;
    }

    private hasRetryExhaustionFinalization(
        typeIds: Set<string>,
        processingAttempts: number,
        staleAfterMs: number
    ): boolean {
        if (!typeIds.has(EnqueuedType.APP_INBOX)) {
            return false;
        }
        const now = this.now();
        const staleBefore = now.subtract({ milliseconds: staleAfterMs });
        return [...this.data.values()].some((entry) =>
            entry.typeId === EnqueuedType.APP_INBOX &&
            entry.status === EntityStatus.RESERVED &&
            !isExpiredResourceEntry(entry, now) &&
            entry.dequeueAudit.attempts >= processingAttempts &&
            entry.dequeueAudit.attempts < Number.MAX_SAFE_INTEGER &&
            entry.dequeueAudit.startTs !== undefined &&
            Temporal.Instant.compare(entry.dequeueAudit.startTs, staleBefore) <= 0
        );
    }

    private isAnyToLock(
        typeIds: Set<string>,
        statusesToFind: ReadonlySet<EntityStatus>,
        maxAttempts: number
    ) {
        for (const entry of this.data.values()) {
            if (
                !isExpiredResourceEntry(entry) &&
                typeIds.has(entry.typeId) &&
                statusesToFind.has(entry.status) &&
                entry.status !== EntityStatus.FAILED &&
                entry.dequeueAudit.attempts < maxAttempts &&
                (
                    !entry.dequeueAudit.nextTs ||
                    Temporal.Instant.compare(this.now(), entry.dequeueAudit.nextTs) >= 0
                )
            ) {
                return true;
            }
        }

        return false;
    }

    private isAnyReservedEntryTimedOut(
        typeIds: Set<string>,
        duration: Temporal.Duration,
        maxAttempts: number
    ) {
        for (const entry of this.data.values()) {
            if (
                entry.dequeueAudit.attempts < maxAttempts &&
                this.isReservedEntryTimedOut(typeIds, entry, duration)
            ) {
                return true;
            }
        }

        return false;
    }

    private isReservedEntryTimedOut(typeIds: Set<string>, entry: ResourceEntry, duration: Temporal.Duration) {
        if (
            !isExpiredResourceEntry(entry) &&
            typeIds.has(entry.typeId) &&
            EntityStatus.RESERVED == entry.status &&
            entry.dequeueAudit.startTs
        ) {
            return Temporal.Instant.compare(
                this.now(),
                entry.dequeueAudit.startTs.add(duration)
            ) >=
                0;
        }

        return false;
    }

    async getItem(key: Key): Promise<ResourceEntry | undefined> {
        const entry = this.data.get(toKeyAsString(key));
        if (!entry) {
            return undefined;
        }

        if (isExpiredResourceEntry(entry)) {
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
        let removed = 0;

        for (const [key, entry] of this.data.entries()) {
            if (!isExpiredResourceEntry(entry)) {
                continue;
            }

            this.removeEntry(key);
            removed += 1;
        }

        return removed;
    }
}

interface InMemoryQueueWrite {
    readonly key: ResourceEntryKeyString;
    readonly expected: ResourceEntry | undefined;
    readonly entry: ResourceEntry | undefined;
    readonly existing: ResourceEntry | undefined;
}

function validateInMemoryQueueWrites(
    writes: readonly InMemoryQueueWrite[],
    observedAt: Temporal.Instant
): Either<Error | 'conflict', readonly InMemoryQueueWrite[]> {
    const keys = new Set<string>();
    const issues: string[] = [];
    for (const write of writes) {
        if (keys.has(write.key)) {
            issues.push('Queue writes contain a duplicate key');
        }
        if (write.expected !== undefined && toKeyAsString(write.expected.key) !== write.key) {
            issues.push('Queue replacement key differs from its observation');
        }
        keys.add(write.key);
    }
    if (issues.length > 0) {
        return Either.ofLeft(new TypeError(issues.join('; ')));
    }
    return writes.some(({ expected, existing }) =>
            expected === undefined
                ? existing !== undefined && !isExpiredResourceEntry(existing, observedAt)
                : existing === undefined || isExpiredResourceEntry(existing, observedAt) ||
                    !hasSameResourceEntryValue(existing, expected)
        )
        ? Either.ofLeft('conflict')
        : Either.ofRight(writes);
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

function isInMemoryQueueEntryReservable(read: InMemoryQueueBox.ReservationRead): boolean {
    const { entry, now } = read;
    return read.typeIds.has(entry.typeId) && read.statusIds.has(entry.status) &&
        !isExpiredResourceEntry(entry, now) && entry.status !== EntityStatus.FAILED &&
        entry.dequeueAudit.attempts < read.maxAttempts &&
        (entry.dequeueAudit.nextTs === undefined || Temporal.Instant.compare(now, entry.dequeueAudit.nextTs) >= 0);
}
