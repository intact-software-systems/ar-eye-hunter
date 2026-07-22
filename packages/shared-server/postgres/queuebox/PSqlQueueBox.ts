import { Temporal } from '@js-temporal/polyfill';
import {
    QueueBoxResourceEntryRepository,
    ResourceInboxFairnessReservationInput,
    ResourceInboxFairnessSelection,
    ResourceInboxLostReservationError,
    ResourceInboxReleaseDisposition,
    ResourceInboxReservationInput,
    ResourceInboxWorkAdvertisementInput,
    isIdempotentCompletedAppInboxRelease,
    toResourceInboxFairnessReservationOptions,
    toResourceInboxReleaseDisposition,
    toResourceInboxReservationOptions,
    toResourceInboxWorkAdvertisementOptions,
} from '@shared/queuebox/QueueBoxTypes.ts';
import type { PersistenceSetItemOptions } from '@shared/persistence/PersistenceProvider.ts';
import { RateLimiter } from '@shared/resilience/Resilience.ts';
import {
    EntityStatus,
    isExpiredResourceEntry,
    Key,
    NEW_AND_RETRY_STATUSES,
    ResourceEntry,
    TIMEOUT_ON_NON_RESPONSIVE_ENTRY,
} from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { ResourceInboxRepository } from '../resource-inbox/ResourceInboxRepository.ts';

export class PSqlQueueBox implements QueueBoxResourceEntryRepository {

    constructor(
        public readonly repo: ResourceInboxRepository
    ) {
    }

    cleanup(): void {
        void this.deleteExpired().catch((error) => {
            console.error('Failed to cleanup expired resource_inbox rows', error);
        });
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
        const isTimedOutReservedEntryToLock: boolean =
            await RateLimiter.tryToExecuteOrDefault(
                checkTimeout,
                async () =>
                    await this.repo.isTimeoutOnReservedEntries(
                        typeIds,
                        TIMEOUT_ON_NON_RESPONSIVE_ENTRY,
                        maxAttempts,
                    ),
                false
            );

        const isNewAndRetryEntryToLock: boolean =
            await this.repo.isEntriesToLock(
                typeIds,
                NEW_AND_RETRY_STATUSES,
                maxAttempts,
            );

        return isNewAndRetryEntryToLock || isTimedOutReservedEntryToLock;
    }

    async reserveEntries(
        typeIds: Set<string>,
        statusIds: Set<EntityStatus>,
        reservationInput: ResourceInboxReservationInput,
    ): Promise<Map<Key, ResourceEntry>> {
        const options = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
        );
        return await this.repo.begin(
            async (txRepo: ResourceInboxRepository) => {

                const foundEntries = await txRepo.findEntriesSkipLocked(typeIds, statusIds, options);

                const reservedEntries = new Map<Key, ResourceEntry>();

                for (const e of foundEntries.values()) {
                    const reserved = await txRepo.startProcessingEntity(e, options.maxAttempts);
                    reserved.fold(
                        () => undefined,
                        (entry) => {
                            reservedEntries.set(e.key, entry);
                            return undefined;
                        },
                    );
                }

                return reservedEntries;
            });
    }

    async reserveTimeoutEntries(
        typeIds: Set<string>,
        reservationInput: ResourceInboxReservationInput,
        timeSinceStartTs: Temporal.Duration,
    ): Promise<Map<Key, ResourceEntry>> {
        const options = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
        );
        return await this.repo.begin(
            async (txRepo: ResourceInboxRepository) => {

                const foundEntries = await txRepo.findTimedOutReservedEntriesSkipLocked(
                    typeIds,
                    timeSinceStartTs.total({ unit: 'milliseconds' }),
                    options,
                );

                const reservedEntries = new Map<Key, ResourceEntry>();

                for (const e of foundEntries.values()) {
                    const reserved = await txRepo.startProcessingEntity(e, options.maxAttempts);
                    reserved.fold(
                        () => undefined,
                        (entry) => {
                            reservedEntries.set(e.key, entry);
                            return undefined;
                        },
                    );
                }

                return reservedEntries;
            });
    }

    async reserveOverdueRetryEntries(
        typeIds: Set<string>,
        overdueBeforeEpochMs: number,
        reservationInput: ResourceInboxFairnessReservationInput,
    ): Promise<Map<Key, ResourceInboxFairnessSelection>> {
        const options = toResourceInboxFairnessReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
        );
        return await this.repo.begin(
            async (txRepo: ResourceInboxRepository) => {
                const foundEntries = await txRepo.findOverdueRetryEntriesSkipLocked(
                    typeIds,
                    overdueBeforeEpochMs,
                    {
                        maxToReserve: options.maxToReserve,
                        maxAttempts: options.maxAttempts,
                    },
                );
                const reservedEntries = new Map<Key, ResourceInboxFairnessSelection>();

                for (const entry of foundEntries.values()) {
                    const selectedNextTs = entry.dequeueAudit.nextTs;
                    const reserved = await txRepo.startProcessingEntity(
                        entry,
                        options.maxAttempts,
                    );
                    reserved.fold(
                        () => undefined,
                        (reservedEntry) => {
                            if (!selectedNextTs) {
                                throw new Error('Fairness selector returned an entry without nextTs');
                            }
                            reservedEntries.set(entry.key, {
                                entry: reservedEntry,
                                selectedDueTs: selectedNextTs,
                            });
                            return undefined;
                        },
                    );
                }

                return reservedEntries;
            },
        );
    }

    async releaseEntries(
        resources: ResourceEntry[],
        releaseInput: ResourceInboxReleaseDisposition,
    ): Promise<Map<Key, ResourceEntry>> {
        const disposition = toResourceInboxReleaseDisposition(releaseInput);
        const releasedAt = Temporal.Now.instant();
        return await this.repo.begin(
            async (txRepo: ResourceInboxRepository) => {

                const releasedEntries = new Map<Key, ResourceEntry>();

                for (const entry of resources) {
                    const updated = await txRepo.releaseReserved(entry.key, {
                        expectedAttempts: entry.dequeueAudit.attempts,
                        releasedAt,
                        disposition,
                    });
                    if (!updated) {
                        const current = await txRepo.findAnyByKey(entry.key);
                        if (!current || !isIdempotentCompletedAppInboxRelease(
                            current,
                            entry,
                            disposition,
                        )) {
                            throw new ResourceInboxLostReservationError(
                                entry.key,
                                entry.dequeueAudit.attempts,
                            );
                        }
                        releasedEntries.set(entry.key, current);
                        continue;
                    }

                    releasedEntries.set(entry.key, updated);
                }

                return releasedEntries;
            });
    }

    async enqueue(resourceEntry: ResourceEntry): Promise<ResourceEntry | undefined> {
        return await this.repo.begin(
            async (txRepo: ResourceInboxRepository) => {
                const previous = await txRepo.findAnyByKey(resourceEntry.key);
                await txRepo.replace(resourceEntry);

                return previous ?? undefined;
            }
        );
    }

    async enqueueIf(
        resourceEntry: ResourceEntry,
        enqueueIt: (existing: ResourceEntry) => boolean,
    ): Promise<ResourceEntry | undefined> {
        return await this.repo.begin(
            async (txRepo: ResourceInboxRepository) => {
                const previous = await txRepo.findAnyByKey(resourceEntry.key);
                if (!previous || isExpiredResourceEntry(previous)) {
                    await txRepo.replace(resourceEntry);
                    return undefined;
                }

                if (enqueueIt(previous)) {
                    await txRepo.replace(resourceEntry);
                }

                return previous;
            }
        );
    }

    async enqueueOrUpdate(
        resourceEntry: ResourceEntry,
        updateExisting: (existing: ResourceEntry) => ResourceEntry | undefined,
    ) {
        return await this.repo.begin(
            async (txRepo: ResourceInboxRepository) => {
                const previous = await txRepo.findAnyByKey(resourceEntry.key);
                if (!previous || isExpiredResourceEntry(previous)) {
                    await txRepo.replace(resourceEntry);
                    return {
                        action: 'inserted' as const,
                        entry: resourceEntry,
                        previous: undefined,
                    };
                }

                const updated = updateExisting(previous);
                if (!updated) {
                    return {
                        action: 'unchanged' as const,
                        entry: previous,
                        previous,
                    };
                }

                await txRepo.replace(updated);
                return {
                    action: 'updated' as const,
                    entry: updated,
                    previous,
                };
            }
        );
    }

    async enqueueIfAbsent(resourceEntry: ResourceEntry): Promise<ResourceEntry> {
        return await this.repo.begin(
            async (txRepo: ResourceInboxRepository) => {
                return await txRepo.writeIfAbsentOrReplaceExpired(resourceEntry);
            }
        );
    }

    async getItem(key: Key): Promise<ResourceEntry | undefined> {
        return await this.repo.findByKey(key) ?? undefined;
    }

    async setItem(
        key: Key,
        value: ResourceEntry,
        _options: PersistenceSetItemOptions,
    ): Promise<void> {
        await this.repo.upsert({
            ...value,
            key,
        });
    }

    async removeItem(key: Key): Promise<void> {
        await this.repo.deleteByKey(key);
    }

    async getAllKeys(): Promise<Key[]> {
        return await this.repo.findAllKeys();
    }

    async deleteExpired(): Promise<number> {
        return await this.repo.deleteExpired();
    }
}
