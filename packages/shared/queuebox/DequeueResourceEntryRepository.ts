import * as Resource from './ResourceEntry.ts'
import {RateLimiter} from "../resilience/Resilience.ts";

export type TimeUnit = "seconds" | "hours";

export interface DequeueResourceEntryRepository {

    isAnyEntryToLock(
        typeIds: Set<string>,
        checkTimeout: RateLimiter,
        checkFailed: RateLimiter
    )
        : boolean;

    reserveEntries(
        typeIds: Set<string>,
        statusIds: Set<Resource.EntityStatus>,
        maxToReserve: number
    )
        : Map<Resource.Key, Resource.ResourceEntry>

    reserveTimeoutEntries(
        typeIds: Set<string>,
        maxToReserve: number,
        timeSinceStartTs: Temporal.Duration
    )
        : Map<Resource.Key, Resource.ResourceEntry>

    releaseEntries(
        resources: Resource.ResourceEntry[],
        entityStatus: Resource.EntityStatus,
        exponentialBackoffSteps?: TimeUnit
    )
        : Map<Resource.Key, Resource.ResourceEntry>
}