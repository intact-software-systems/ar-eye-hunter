import { Temporal } from '@js-temporal/polyfill';
import type { PersistenceProvider } from '../persistence/PersistenceProvider.ts';
import * as Resource from './ResourceEntry.ts';
import { type Key, ResourceEntry } from './ResourceEntry.ts';
import { RateLimiter } from '../resilience/Resilience.ts';

export type { PersistenceProvider } from '../persistence/PersistenceProvider.ts';

export type ResourceInboxReservationOptions = Readonly<{
    maxToReserve: number;
    maxAttempts: number;
}>;

export type ResourceInboxReservationInput = number | ResourceInboxReservationOptions;

export type ResourceInboxFairnessSelection = Readonly<{
    entry: ResourceEntry;
    selectedDueTs: Temporal.Instant;
}>;

export class ResourceInboxLostReservationError extends Error {
    readonly code = 'resource-inbox-lost-reservation';

    constructor(
        readonly key: Key,
        readonly expectedAttempts: number,
    ) {
        super(
            `Resource inbox reservation was lost before release: ${JSON.stringify(key)}`,
        );
        this.name = 'ResourceInboxLostReservationError';
    }
}

export function toResourceInboxReservationOptions(
    input: ResourceInboxReservationInput,
    defaultMaxAttempts: number,
): ResourceInboxReservationOptions {
    const options = typeof input === 'number'
        ? { maxToReserve: input, maxAttempts: defaultMaxAttempts }
        : input;

    if (!Number.isSafeInteger(options.maxToReserve) || options.maxToReserve < 0) {
        throw new Error('maxToReserve must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1) {
        throw new Error('maxAttempts must be a positive safe integer');
    }

    return options;
}

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
        options: ResourceInboxReservationInput,
    )
        : Promise<Map<Resource.Key, Resource.ResourceEntry>>;

    reserveTimeoutEntries(
        typeIds: Set<string>,
        options: ResourceInboxReservationInput,
        timeSinceStartTs: Temporal.Duration
    )
        : Promise<Map<Resource.Key, Resource.ResourceEntry>>;

    reserveOverdueRetryEntries(
        typeIds: Set<string>,
        overdueBeforeEpochMs: number,
        options: ResourceInboxReservationInput,
    )
        : Promise<Map<Resource.Key, ResourceInboxFairnessSelection>>;

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
