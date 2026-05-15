import { Temporal } from '@js-temporal/polyfill';
import type { PersistenceProvider } from '../persistence/PersistenceProvider.ts';
import * as Resource from './ResourceEntry.ts';
import { ResourceEntry } from './ResourceEntry.ts';
import { RateLimiter } from '../resilience/Resilience.ts';

export type { PersistenceProvider } from '../persistence/PersistenceProvider.ts';

export interface DequeueResourceEntryRepository {

    isAnyEntryToLock(
        typeIds: Set<string>,
        checkTimeout: RateLimiter,
        checkFailed: RateLimiter
    )
        : Promise<boolean>;

    reserveEntries(
        typeIds: Set<string>,
        statusIds: Set<Resource.EntityStatus>,
        maxToReserve: number
    )
        : Promise<Map<Resource.Key, Resource.ResourceEntry>>;

    reserveTimeoutEntries(
        typeIds: Set<string>,
        maxToReserve: number,
        timeSinceStartTs: Temporal.Duration
    )
        : Promise<Map<Resource.Key, Resource.ResourceEntry>>;

    releaseEntries(
        resources: Resource.ResourceEntry[],
        entityStatus: Resource.EntityStatus,
        exponentialBackoffSteps?: Temporal.TimeUnit
    )
        : Promise<Map<Resource.Key, Resource.ResourceEntry>>;
}

export interface EnqueueResourceEntryController {
    enqueueIfAbsent(resourceEntry: ResourceEntry): Promise<ResourceEntry>;

    enqueue(resourceEntry: ResourceEntry): Promise<ResourceEntry | undefined>;

    cleanup(): void;
}

export interface QueueBoxResourceEntryRepository
    extends DequeueResourceEntryRepository, EnqueueResourceEntryController, PersistenceProvider<Resource.Key, Resource.ResourceEntry> {
}
