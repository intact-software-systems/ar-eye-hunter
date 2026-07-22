import { Temporal } from '@js-temporal/polyfill';
import type { PersistenceProvider } from '../persistence/PersistenceProvider.ts';
import * as Resource from './ResourceEntry.ts';
import { type Key, ResourceEntry } from './ResourceEntry.ts';
import { RateLimiter } from '../resilience/Resilience.ts';

export type { PersistenceProvider } from '../persistence/PersistenceProvider.ts';

export interface DequeueResourceEntryRepository {

    isAnyEntryToLock(
        typeIds: Set<string>,
        checkTimeout: RateLimiter,
        checkFairness: RateLimiter,
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

    reserveOverdueRetryEntries(
        typeIds: Set<string>,
        overdueBeforeEpochMs: number,
        maxToReserve: number,
    )
        : Promise<Map<Resource.Key, Resource.ResourceEntry>>;

    releaseEntries(
        resources: Resource.ResourceEntry[],
        entityStatus: Resource.EntityStatus,
        delayMs: number | null,
    )
        : Promise<Map<Resource.Key, Resource.ResourceEntry>>;
}

export interface EnqueueResourceEntryController {
    enqueueIfAbsent(resourceEntry: ResourceEntry): Promise<ResourceEntry>;

    enqueueOrUpdate(
        resourceEntry: ResourceEntry,
        updateExisting: (existing: ResourceEntry) => ResourceEntry | undefined,
    ): Promise<EnqueueOrUpdateResult>;

    enqueueIf(
        resourceEntry: ResourceEntry,
        enqueueIt: (existing: ResourceEntry) => boolean,
    ): Promise<ResourceEntry | undefined>;

    enqueue(resourceEntry: ResourceEntry): Promise<ResourceEntry | undefined>;

    cleanup(): void;
}

export type EnqueueOrUpdateAction = 'inserted' | 'updated' | 'unchanged';

export type EnqueueOrUpdateResult = Readonly<{
    action: EnqueueOrUpdateAction;
    entry: ResourceEntry;
    previous?: ResourceEntry;
}>;

export interface EnqueueBoxResourceEntryRepository
    extends EnqueueResourceEntryController {

    findByKey(key: Key): Promise<ResourceEntry | undefined>
}

export interface QueueBoxResourceEntryRepository
    extends DequeueResourceEntryRepository, EnqueueResourceEntryController, PersistenceProvider<Resource.Key, Resource.ResourceEntry> {
}
