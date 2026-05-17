// deno-lint-ignore-file require-await
import { Temporal } from '@js-temporal/polyfill';
import { RateLimiter } from '../resilience/Resilience.ts';
import type { PersistenceSetItemOptions } from '../persistence/PersistenceProvider.ts';
import { QueueBoxResourceEntryRepository } from './QueueBoxTypes.ts';
import {
    COMPLETED_STATUSES,
    EntityStatus,
    FAILED_STATUS,
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
        entityStatus: EntityStatus,
        exponentialBackoffSteps?: Temporal.TimeUnit
    ): Promise<Map<Key, ResourceEntry>> {
        return new Map(
            resources
                .map(
                    (resource): [Key, ResourceEntry] => {
                        resource.dequeueAudit = {
                            startTs: resource.dequeueAudit.startTs,
                            endTs: Temporal.Now.instant(),
                            nextTs:
                                exponentialBackoffSteps
                                    ? this.toExponentialBackoffInstant(exponentialBackoffSteps, resource.dequeueAudit.attempts)
                                    : undefined,
                            attempts: resource.dequeueAudit.attempts
                        };
                        resource.status = entityStatus;

                        this.data.set(toKeyAsString(resource.key), resource);

                        return [resource.key, resource];
                    }
                )
        );
    }

    async reserveTimeoutEntries(
        typeIds: Set<string>,
        maxToReserve: number,
        timeSinceStartTs: Temporal.Duration
    ): Promise<Map<Key, ResourceEntry>> {
        const timedOut = new Map<Key, ResourceEntry>();

        for (const [key, entry] of this.data) {
            if (timedOut.size >= maxToReserve) {
                break;
            }

            if (this.isReservedEntryTimedOut(typeIds, entry, timeSinceStartTs)) {
                entry.dequeueAudit = {
                    startTs: entry.dequeueAudit.startTs,
                    endTs: Temporal.Now.instant(),
                    nextTs: undefined,
                    attempts: entry.dequeueAudit.attempts
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
        maxToReserve: number
    ): Promise<Map<Key, ResourceEntry>> {
        const reserved = new Map<Key, ResourceEntry>();
        const now = Temporal.Now.instant();

        for (const [key, entry] of this.data) {
            if (reserved.size >= maxToReserve) {
                break;
            }

            if (isExpiredResourceEntry(entry)) {
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

    async isAnyEntryToLock(typeIds: Set<string>, checkTimeout: RateLimiter, checkFailed: RateLimiter): Promise<boolean> {
        const isFailedEntryToLock =
            await RateLimiter.tryToExecuteOrDefault(
                checkFailed,
                async () => this.isAnyToLock(typeIds, FAILED_STATUS),
                false
            );

        const isTimedOutEntryToLock =
            await RateLimiter.tryToExecuteOrDefault(
                checkTimeout,
                async () => this.isAnyReservedEntryTimedOut(typeIds, TIMEOUT_ON_NON_RESPONSIVE_ENTRY),
                false
            );

        const newAndRetryEntryToLock = this.isAnyToLock(typeIds, NEW_AND_RETRY_STATUSES);

        this.cleanupAsync()
            .catch(e => {
                console.error('Failed to cleanup entries', e);
                return false;
            });

        return newAndRetryEntryToLock || isTimedOutEntryToLock || isFailedEntryToLock;
    }

    private isAnyToLock(typeIds: Set<string>, statusesToFind: ReadonlySet<EntityStatus>) {
        for (const entry of this.data.values()) {
            if (
                !isExpiredResourceEntry(entry)
                && typeIds.has(entry.typeId)
                && statusesToFind.has(entry.status)
            ) {
                return true;
            }
        }

        return false;
    }

    private isAnyReservedEntryTimedOut(typeIds: Set<string>, duration: Temporal.Duration) {
        for (const entry of this.data.values()) {
            if (this.isReservedEntryTimedOut(typeIds, entry, duration)) {
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

    private toExponentialBackoffInstant(timeUnit: Temporal.TimeUnit, attempts: number): Temporal.Instant {
        const num = this.toExponentialBackoff(attempts);

        return timeUnit == 'second'
            ? Temporal.Now.instant().add({ seconds: num })
            : Temporal.Now.instant().add({ minutes: num });
    }

    private toExponentialBackoff(attempts: number): number {
        return attempts <= 1
            ? attempts == 0 ? 1 : 2
            :
            Math.pow(
                2,
                attempts
            );
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
