import {RateLimiter} from "../resilience/Resilience.ts";
import {DequeueResourceEntryRepository, TimeUnit} from "./DequeueResourceEntryRepository.ts";
import {EnqueueResourceEntryController} from "./EnqueueResourceEntryController.ts";
import {
    EntityStatus,
    FAILED_STATUS,
    Key,
    NEW_AND_RETRY_STATUSES,
    ResourceEntry,
    TIMEOUT_ON_NON_RESPONSIVE_ENTRY
} from "./ResourceEntry.ts";

// Unordered in memory
export class UnorderedInMemoryQueueBox implements DequeueResourceEntryRepository, EnqueueResourceEntryController {

    // If I want ordered then
    // private ordered: Map<bigint, ResourceEntry> where the number is an ever-increasing identifier
    private readonly data: Map<Key, ResourceEntry>;

    constructor(data: Map<Key, ResourceEntry>) {
        this.data = data;
    }

    put(resourceEntry: ResourceEntry): ResourceEntry | undefined {
        const prev = this.data.get(resourceEntry.key)
        this.data.set(resourceEntry.key, resourceEntry);

        return prev
    }

    putIfAbsent(resourceEntry: ResourceEntry): ResourceEntry {
        const prev = this.data.get(resourceEntry.key)

        if (!prev) {
            this.data.set(resourceEntry.key, resourceEntry);
            return resourceEntry
        }

        return prev;
    }

    releaseEntries(
        resources: ResourceEntry[],
        entityStatus: EntityStatus,
        exponentialBackoffSteps?: TimeUnit
    ): Map<Key, ResourceEntry> {
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

                        return [resource.key, resource];
                    }
                )
        );
    }

    reserveTimeoutEntries(
        typeIds: Set<string>,
        maxToReserve: number,
        timeSinceStartTs: Temporal.Duration
    ): Map<Key, ResourceEntry> {
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
                    key,
                    entry
                );
            }
        }

        return timedOut;
    }

    reserveEntries(
        typeIds: Set<string>,
        statusIds: Set<EntityStatus>,
        maxToReserve: number
    ): Map<Key, ResourceEntry> {
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

                reserved.set(key, entry);
            }
        }

        return reserved;
    }

    isAnyEntryToLock(typeIds: Set<string>, checkTimeout: RateLimiter, checkFailed: RateLimiter): boolean {
        const isFailedEntryToLock =
            RateLimiter.tryToExecuteOrDefault(
                checkFailed,
                () => this.isAnyToLock(typeIds, FAILED_STATUS),
                false
            )

        const isTimedOutEntryToLock =
            RateLimiter.tryToExecuteOrDefault(
                checkTimeout,
                () => this.isAnyReservedEntryTimedOut(typeIds, TIMEOUT_ON_NON_RESPONSIVE_ENTRY),
                false
            )

        const newAndRetryEntryToLock = this.isAnyToLock(typeIds, NEW_AND_RETRY_STATUSES);

        return newAndRetryEntryToLock || isTimedOutEntryToLock || isFailedEntryToLock;
    }

    private isAnyToLock(typeIds: Set<string>, statusesToFind: ReadonlySet<EntityStatus>) {
        // isNewAndRetryEntryToLock
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

    private toExponentialBackoffInstant(timeUnit: string, attempts: number): Temporal.Instant {
        const num = this.toExponentialBackoff(attempts)

        return timeUnit == "seconds"
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
