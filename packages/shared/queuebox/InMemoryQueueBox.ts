// deno-lint-ignore-file require-await
import { Temporal } from '@js-temporal/polyfill';
import { RateLimiter } from '../resilience/Resilience.ts';
import type { PersistenceSetItemOptions } from '../persistence/PersistenceProvider.ts';
import {
    QueueBoxResourceEntryRepository,
    ResourceInboxFairnessReservationInput,
    ResourceInboxFairnessSelection,
    ResourceInboxLostReservationError,
    ResourceInboxReleaseDisposition,
    ResourceInboxReservationInput,
    ResourceInboxWorkAdvertisementInput,
    toResourceInboxFairnessReservationOptions,
    toResourceInboxReleaseDisposition,
    toResourceInboxReservationOptions,
    toResourceInboxWorkAdvertisementOptions,
} from './QueueBoxTypes.ts';
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
import { ResilienceDto } from './DequeueResourceEntryController.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from './ResourceInboxRetryPolicy.ts';

export class InMemoryQueueBox implements QueueBoxResourceEntryRepository {
    private readonly data: Map<ResourceEntryKeyString, ResourceEntry>;

    private readonly cleanupRateLimiter: RateLimiter =
        RateLimiter.init(
            ResilienceDto.RATE_LIMITER_RESERVED_TIMEOUT_SLIDING_WINDOW_DURATION_MS,
            ResilienceDto.MAX_NUM_IS_ENTRY_CHECK,
        );

    constructor(input: Map<Key, ResourceEntry> = new Map<Key, ResourceEntry>()) {
        this.data = new Map<ResourceEntryKeyString, ResourceEntry>();

        for (const [key, entry] of input) {
            this.data.set(toKeyAsString(key), entry);
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
        const prev = this.data.get(toKeyAsString(resourceEntry.key));
        this.data.set(toKeyAsString(resourceEntry.key), resourceEntry);

        return prev;
    }

    async enqueueIf(
        resourceEntry: ResourceEntry,
        enqueueIt: (existing: ResourceEntry) => boolean,
    ): Promise<ResourceEntry | undefined> {
        const key = toKeyAsString(resourceEntry.key);
        const prev = this.data.get(key);

        if (!prev || isExpiredResourceEntry(prev)) {
            this.data.set(key, resourceEntry);
            return undefined;
        }

        if (enqueueIt(prev)) {
            this.data.set(key, resourceEntry);
        } else {
            console.log('Entry already exists: ', resourceEntry.key);
        }

        return prev;
    }

    async enqueueOrUpdate(
        resourceEntry: ResourceEntry,
        updateExisting: (existing: ResourceEntry) => ResourceEntry | undefined,
    ) {
        const key = toKeyAsString(resourceEntry.key);
        const previous = this.data.get(key);

        if (!previous || isExpiredResourceEntry(previous)) {
            this.data.set(key, resourceEntry);
            return {
                action: 'inserted' as const,
                entry: resourceEntry,
                previous: undefined,
            };
        }

        const updated = updateExisting(previous);
        if (!updated) {
            console.log('Entry already exists: ', resourceEntry.key);
            return {
                action: 'unchanged' as const,
                entry: previous,
                previous,
            };
        }

        this.data.set(key, updated);
        return {
            action: 'updated' as const,
            entry: updated,
            previous,
        };
    }

    async enqueueIfAbsent(resourceEntry: ResourceEntry): Promise<ResourceEntry> {
        const prev = this.data.get(toKeyAsString(resourceEntry.key));

        if (!prev || isExpiredResourceEntry(prev)) {
            this.data.set(toKeyAsString(resourceEntry.key), resourceEntry);
            return resourceEntry;
        } else {
            console.log('Entry already exists: ', resourceEntry.key);
        }

        return prev;
    }

    async releaseEntries(
        resources: ResourceEntry[],
        releaseInput: ResourceInboxReleaseDisposition,
    ): Promise<Map<Key, ResourceEntry>> {
        const disposition = toResourceInboxReleaseDisposition(releaseInput);
        const currentEntries = resources.map(resource => {
            const current = this.data.get(toKeyAsString(resource.key));
            if (
                !current ||
                isExpiredResourceEntry(current) ||
                current.status !== EntityStatus.RESERVED ||
                current.dequeueAudit.attempts !== resource.dequeueAudit.attempts
            ) {
                throw new ResourceInboxLostReservationError(
                    resource.key,
                    resource.dequeueAudit.attempts,
                );
            }
            return current;
        });
        const releasedAt = Temporal.Now.instant();
        const released = new Map<Key, ResourceEntry>();

        for (const current of currentEntries) {
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
            this.data.set(toKeyAsString(current.key), updated);
            released.set(updated.key, updated);
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
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
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
                entry.dequeueAudit = {
                    startTs: now,
                    endTs: undefined,
                    nextTs: undefined,
                    attempts: entry.dequeueAudit.attempts + 1,
                };

                entry.status = EntityStatus.RESERVED;

                timedOut.set(
                    toResourceEntryKey(key),
                    entry
                );
            }
        }

        return timedOut;
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
                entry.dequeueAudit = {
                    startTs: Temporal.Now.instant(),
                    endTs: undefined,
                    nextTs: undefined,
                    attempts: entry.dequeueAudit.attempts + 1
                };

                entry.status = EntityStatus.RESERVED;

                reserved.set(toResourceEntryKey(key), entry);
            }
        }

        return reserved;
    }

    async reserveOverdueRetryEntries(
        typeIds: Set<string>,
        overdueBeforeEpochMs: number,
        reservationInput: ResourceInboxFairnessReservationInput,
    ): Promise<Map<Key, ResourceInboxFairnessSelection>> {
        const { maxToReserve, maxAttempts } = toResourceInboxFairnessReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
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
                    right.dequeueAudit.nextTs!,
                );
                return dueOrder !== 0 ? dueOrder : leftKey.localeCompare(rightKey);
            })
            .slice(0, maxToReserve);
        const reserved = new Map<Key, ResourceInboxFairnessSelection>();

        for (const [key, entry] of candidates) {
            const selectedNextTs = entry.dequeueAudit.nextTs;
            const updated = {
                ...entry,
                status: EntityStatus.RESERVED,
                dequeueAudit: {
                    startTs: now,
                    endTs: undefined,
                    nextTs: undefined,
                    attempts: entry.dequeueAudit.attempts + 1,
                },
            };
            this.data.set(key, updated);
            reserved.set(toResourceEntryKey(key), {
                entry: updated,
                selectedDueTs: selectedNextTs!,
            });
        }

        return reserved;
    }

    async isAnyEntryToLock(
        typeIds: Set<string>,
        workInput: ResourceInboxWorkAdvertisementInput,
        legacyCheckFairness?: RateLimiter,
    ): Promise<boolean> {
        const { checkTimeout, maxAttempts } = toResourceInboxWorkAdvertisementOptions(
            workInput,
            legacyCheckFairness,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
        );
        const isTimedOutEntryToLock =
            await RateLimiter.tryToExecuteOrDefault(
                checkTimeout,
                async () => this.isAnyReservedEntryTimedOut(
                    typeIds,
                    TIMEOUT_ON_NON_RESPONSIVE_ENTRY,
                    maxAttempts,
                ),
                false
            );

        const newAndRetryEntryToLock = this.isAnyToLock(
            typeIds,
            NEW_AND_RETRY_STATUSES,
            maxAttempts,
        );

        this.cleanupAsync()
            .catch(e => {
                console.error('Failed to cleanup entries', e);
                return false;
            });

        return newAndRetryEntryToLock || isTimedOutEntryToLock;
    }

    private isAnyToLock(
        typeIds: Set<string>,
        statusesToFind: ReadonlySet<EntityStatus>,
        maxAttempts: number,
    ) {
        for (const entry of this.data.values()) {
            if (
                !isExpiredResourceEntry(entry)
                && typeIds.has(entry.typeId)
                && statusesToFind.has(entry.status)
                && entry.status !== EntityStatus.FAILED
                && entry.dequeueAudit.attempts < maxAttempts
                && (
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
        maxAttempts: number,
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
            // Result is 1 if now > deadline, 0 if equal, -1 if now < deadline
            return Temporal.Instant.compare(
                    Temporal.Now.instant(), // now
                    entry.dequeueAudit.startTs.add(duration) // deadline
                )
                >= 0;
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

        return entry;
    }

    async setItem(
        key: Key,
        value: ResourceEntry,
        _options: PersistenceSetItemOptions,
    ): Promise<void> {
        this.data.set(
            toKeyAsString(key),
            {
                ...value,
                key,
            },
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
