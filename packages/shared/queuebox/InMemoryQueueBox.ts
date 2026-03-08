// deno-lint-ignore-file require-await
import { RateLimiter } from "../resilience/Resilience.ts";
import { QueueBoxResourceEntryRepository } from "./QueueBoxTypes.ts";
import {
    EntityStatus,
    FAILED_STATUS,
    Key,
    NEW_AND_RETRY_STATUSES,
    ResourceEntry,
    ResourceEntryKeyString,
    TIMEOUT_ON_NON_RESPONSIVE_ENTRY,
    toKeyAsString,
    toResourceEntryKey
} from "./ResourceEntry.ts";

export class InMemoryQueueBox implements QueueBoxResourceEntryRepository {
    private readonly data: Map<ResourceEntryKeyString, ResourceEntry>;

    constructor(input: Map<Key, ResourceEntry> = new Map<Key, ResourceEntry>()) {
        this.data = new Map<ResourceEntryKeyString, ResourceEntry>();

        for (const [key, entry] of input) {
            this.data.set(toKeyAsString(key), entry);
        }
    }

    async enqueue(resourceEntry: ResourceEntry): Promise<ResourceEntry | undefined> {
        const prev = this.data.get(toKeyAsString(resourceEntry.key))
        this.data.set(toKeyAsString(resourceEntry.key), resourceEntry);

        return prev
    }

    async enqueueIfAbsent(resourceEntry: ResourceEntry): Promise<ResourceEntry> {
        const prev = this.data.get(toKeyAsString(resourceEntry.key))

        if (!prev) {
            this.data.set(toKeyAsString(resourceEntry.key), resourceEntry);
            return resourceEntry
        } else {
            console.log("Entry already exists: ", resourceEntry.key)
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
            if (timedOut.size > maxToReserve) {
                break;
            }

            if (this.isReservedEntryTimedOut(typeIds, entry, timeSinceStartTs)) {
                entry.dequeueAudit = {
                    startTs: entry.dequeueAudit.startTs,
                    endTs: Temporal.Now.instant(),
                    nextTs: undefined,
                    attempts: entry.dequeueAudit.attempts
                };

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

        for (const [key, entry] of this.data) {
            if (reserved.size > maxToReserve) {
                break;
            }

            if (typeIds.has(entry.typeId) && statusIds.has(entry.status)) {
                entry.dequeueAudit = {
                    startTs: Temporal.Now.instant(),
                    endTs: undefined,
                    nextTs: undefined,
                    attempts: entry.dequeueAudit.attempts + 1
                };

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
            )

        const isTimedOutEntryToLock =
            await RateLimiter.tryToExecuteOrDefault(
                checkTimeout,
                async () => this.isAnyReservedEntryTimedOut(typeIds, TIMEOUT_ON_NON_RESPONSIVE_ENTRY),
                false
            )

        const newAndRetryEntryToLock = this.isAnyToLock(typeIds, NEW_AND_RETRY_STATUSES);

        return newAndRetryEntryToLock || isTimedOutEntryToLock || isFailedEntryToLock;
    }

    private isAnyToLock(typeIds: Set<string>, statusesToFind: ReadonlySet<EntityStatus>) {
        for (const entry of this.data.values()) {
            if (typeIds.has(entry.typeId) && statusesToFind.has(entry.status)) {
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
            typeIds.has(entry.typeId) &&
            EntityStatus.RESERVED == entry.status &&
            entry.dequeueAudit.startTs
        ) {
            // Result is 1 if now > deadline, 0 if equal, -1 if now < deadline
            return Temporal.Instant.compare(
                    Temporal.Now.instant(), // now
                    entry.dequeueAudit.startTs.add(duration) // deadline
                )
                >= 0
        }

        return false
    }

    private toExponentialBackoffInstant(timeUnit: Temporal.TimeUnit, attempts: number): Temporal.Instant {
        const num = this.toExponentialBackoff(attempts)

        return timeUnit == "second"
            ? Temporal.Now.instant().add({seconds: num})
            : Temporal.Now.instant().add({minutes: num})
    }

    private toExponentialBackoff(attempts: number): number {
        return attempts <= 1
            ? attempts == 0 ? 1 : 2
            :
            Math.pow(
                2,
                attempts
            )
    }
}
