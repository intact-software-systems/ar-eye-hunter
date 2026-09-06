import { Temporal } from '@js-temporal/polyfill';

import { EnqueuedType } from '../api/api-config.ts';
import type { PersistenceSetItemOptions } from '../persistence/PersistenceProvider.ts';
import { RateLimiter } from '../resilience/Resilience.ts';
import { ResilienceDto } from './DequeueResourceEntryController.ts';
import { hasSameResourceEntryValue } from './has-same-resource-entry-value.ts';
import {
    isIdempotentHandlerFinalizedRelease,
    QueueBoxResourceEntryRepository,
    ResourceInboxFairnessReservationInput,
    ResourceInboxFairnessSelection,
    ResourceInboxFinalizationReservationOptions,
    ResourceInboxFinalizationSelection,
    ResourceInboxLostReservationError,
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

export class InMemoryQueueBox implements QueueBoxResourceEntryRepository {
    private readonly data: Map<ResourceEntryKeyString, ResourceEntry>;

    private readonly cleanupRateLimiter: RateLimiter = RateLimiter.init(
        ResilienceDto.RATE_LIMITER_RESERVED_TIMEOUT_SLIDING_WINDOW_DURATION_MS,
        ResilienceDto.MAX_NUM_IS_ENTRY_CHECK
    );

    constructor(input: Map<Key, ResourceEntry> = new Map<Key, ResourceEntry>()) {
        this.data = new Map<ResourceEntryKeyString, ResourceEntry>();

        for (const [key, entry] of input) {
            this.data.set(toKeyAsString(key), toResourceEntrySnapshot(entry));
        }
    }

    async cleanupAsync(): Promise<boolean> {
        return RateLimiter.tryToExecuteOrDefault(
            this.cleanupRateLimiter,
            async () => this.cleanup(),
            false
        );
    }

    cleanup(): boolean {
        const keysToRemove: ResourceEntryKeyString[] = [];

        for (const [key, entry] of this.data) {
            if (COMPLETED_STATUSES.has(entry.status) || isExpiredResourceEntry(entry)) {
                keysToRemove.push(key);
            }
        }

        for (const key of keysToRemove) {
            this.data.delete(key);
        }

        if (keysToRemove.length > 0) {
            console.log('Removed entries: ', keysToRemove.length);
        }

        return keysToRemove.length > 0;
    }

    async enqueue(resourceEntry: ResourceEntry): Promise<ResourceEntry | undefined> {
        const previous = this.data.get(toKeyAsString(resourceEntry.key));
        this.data.set(toKeyAsString(resourceEntry.key), toResourceEntrySnapshot(resourceEntry));

        return previous === undefined ? undefined : toResourceEntrySnapshot(previous);
    }

    async replaceIfObserved(
        expected: ResourceEntry,
        replacement: ResourceEntry
    ): Promise<ResourceEntry | null> {
        const key = toKeyAsString(expected.key);
        if (key !== toKeyAsString(replacement.key)) {
            throw new TypeError('Queue replacement key differs from its observation');
        }
        const current = this.data.get(key);
        if (
            current === undefined ||
            isExpiredResourceEntry(current) ||
            !hasSameResourceEntryValue(current, expected)
        ) {
            return null;
        }

        this.data.set(key, toResourceEntrySnapshot(replacement));
        return toResourceEntrySnapshot(replacement);
    }

    async enqueueIfAbsent(resourceEntry: ResourceEntry): Promise<ResourceEntry> {
        const previous = this.data.get(toKeyAsString(resourceEntry.key));

        if (!previous || isExpiredResourceEntry(previous)) {
            this.data.set(toKeyAsString(resourceEntry.key), toResourceEntrySnapshot(resourceEntry));
            return toResourceEntrySnapshot(resourceEntry);
        }

        return toResourceEntrySnapshot(previous);
    }

    async tryWriteIfAbsentOrReplaceExpired(
        resourceEntry: ResourceEntry
    ): Promise<ResourceEntry | null> {
        const key = toKeyAsString(resourceEntry.key);
        const current = this.data.get(key);
        if (current !== undefined && !isExpiredResourceEntry(current)) {
            return null;
        }

        this.data.set(key, toResourceEntrySnapshot(resourceEntry));
        return toResourceEntrySnapshot(resourceEntry);
    }

    async releaseEntries(
        resources: ResourceEntry[],
        releaseInput: ResourceInboxReleaseDisposition
    ): Promise<Map<Key, ResourceEntry>> {
        const disposition = toResourceInboxReleaseDisposition(releaseInput);
        const currentEntries = resources.map((resource) => {
            const current = this.data.get(toKeyAsString(resource.key));
            if (
                !current ||
                (
                    (
                        isExpiredResourceEntry(current) ||
                        current.status !== EntityStatus.RESERVED ||
                        current.dequeueAudit.attempts !== resource.dequeueAudit.attempts
                    ) &&
                    !isIdempotentHandlerFinalizedRelease(
                        current,
                        resource,
                        disposition
                    )
                )
            ) {
                throw new ResourceInboxLostReservationError(
                    resource.key,
                    resource.dequeueAudit.attempts
                );
            }
            return current;
        });
        const releasedAt = Temporal.Now.instant();
        const released = new Map<Key, ResourceEntry>();

        for (const current of currentEntries) {
            if (current.status !== EntityStatus.RESERVED) {
                const snapshot = toResourceEntrySnapshot(current);
                released.set(snapshot.key, snapshot);
                continue;
            }
            const updated = computeReleasedResourceEntry(current, disposition, releasedAt);
            this.data.set(toKeyAsString(current.key), updated);
            const snapshot = toResourceEntrySnapshot(updated);
            released.set(snapshot.key, snapshot);
        }

        return released;
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
        const timedOut = new Map<Key, ResourceEntry>();
        const now = Temporal.Now.instant();

        for (const [key, entry] of this.data) {
            if (timedOut.size >= maxToReserve) {
                break;
            }

            if (
                entry.dequeueAudit.attempts < maxAttempts &&
                this.isReservedEntryTimedOut(typeIds, entry, timeSinceStartTs)
            ) {
                const updated = computeReservedResourceEntry(entry, now);
                this.data.set(key, updated);
                timedOut.set(toResourceEntryKey(key), toResourceEntrySnapshot(updated));
            }
        }

        return timedOut;
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
        const reserved = new Map<Key, ResourceEntry>();
        const now = Temporal.Now.instant();

        for (const [key, entry] of this.data) {
            if (reserved.size >= maxToReserve) {
                break;
            }

            if (isExpiredResourceEntry(entry)) {
                continue;
            }

            if (
                entry.status === EntityStatus.FAILED ||
                entry.dequeueAudit.attempts >= maxAttempts
            ) {
                continue;
            }

            if (entry.dequeueAudit.nextTs && Temporal.Instant.compare(now, entry.dequeueAudit.nextTs) < 0) {
                continue;
            }

            if (typeIds.has(entry.typeId) && statusIds.has(entry.status)) {
                const updated = computeReservedResourceEntry(entry, now);
                this.data.set(key, updated);
                reserved.set(toResourceEntryKey(key), toResourceEntrySnapshot(updated));
            }
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
        const now = Temporal.Now.instant();
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
            this.data.set(key, updated);
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
        if (!typeIds.has(EnqueuedType.APP_INBOX) || options.maxToReserve === 0) {
            return new Map();
        }
        const now = Temporal.Now.instant();
        const staleBefore = now.subtract({ milliseconds: options.staleAfterMs });
        const candidates = [...this.data.entries()].filter(([, entry]) =>
            entry.typeId === EnqueuedType.APP_INBOX &&
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
            this.data.set(key, updated);
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
        const now = Temporal.Now.instant();
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
                    Temporal.Instant.compare(Temporal.Now.instant(), entry.dequeueAudit.nextTs) >= 0
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
                Temporal.Now.instant(),
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
            this.data.delete(toKeyAsString(key));
            return undefined;
        }

        return toResourceEntrySnapshot(entry);
    }

    async setItem(
        key: Key,
        value: ResourceEntry,
        _options: PersistenceSetItemOptions
    ): Promise<void> {
        this.data.set(
            toKeyAsString(key),
            toResourceEntrySnapshot({
                ...value,
                key
            })
        );
    }

    async removeItem(key: Key): Promise<void> {
        this.data.delete(toKeyAsString(key));
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

            this.data.delete(key);
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

function computeReleasedResourceEntry(
    entry: ResourceEntry,
    disposition: ResourceInboxReleaseDisposition,
    releasedAt: Temporal.Instant
): ResourceEntry {
    return {
        ...entry,
        status: disposition.status,
        dequeueAudit: {
            startTs: entry.dequeueAudit.startTs,
            endTs: releasedAt,
            nextTs: disposition.delayMs !== null
                ? releasedAt.add({ milliseconds: disposition.delayMs })
                : undefined,
            attempts: entry.dequeueAudit.attempts
        }
    };
}

function toResourceEntrySnapshot(entry: ResourceEntry): ResourceEntry {
    // Temporal leaves are immutable; copy the mutable records without structuredClone losing their prototypes.
    return {
        ...entry,
        key: { ...entry.key },
        audit: { ...entry.audit },
        dequeueAudit: { ...entry.dequeueAudit },
        db: entry.db === undefined ? undefined : { ...entry.db }
    };
}
