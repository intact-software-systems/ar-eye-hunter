import { Temporal } from '@js-temporal/polyfill';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { PersistenceSetItemOptions } from '@shared/persistence/PersistenceProvider.ts';
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
} from '@shared/queuebox/queue-box-types.ts';
import {
    EntityStatus,
    Key,
    NEW_AND_RETRY_STATUSES,
    ResourceEntry,
    TIMEOUT_ON_NON_RESPONSIVE_ENTRY
} from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { RateLimiter } from '@shared/resilience/Resilience.ts';
import { toError } from '@shared/resilience/to-error.ts';

import { isAdminPruneHandlerFinalizedRelease } from '../../rallar-system/admin-operations/prune/is-admin-prune-handler-finalized-release.ts';
import type { PSqlResourceInboxRepository } from './create-p-sql-resource-inbox-repository.ts';

export class PSqlQueueBox implements QueueBoxResourceEntryRepository {
    public readonly resourceInbox: PSqlResourceInboxRepository;

    constructor(
        resourceInbox: PSqlResourceInboxRepository
    ) {
        this.resourceInbox = resourceInbox;
    }

    cleanup(): void {
        void this.deleteExpired().catch((error) => {
            console.error('Failed to cleanup expired resource_inbox rows', toError(error));
        });
    }

    async isAnyEntryToLock(
        typeIds: Set<string>,
        workInput: ResourceInboxWorkAdvertisementOptions
    ): Promise<boolean> {
        const { checkTimeout, checkFinalization, maxAttempts, finalizationStaleAfterMs } =
            toResourceInboxWorkAdvertisementOptions(workInput);
        const isTimedOutReservedEntryToLock: boolean = await RateLimiter.tryToExecuteOrDefault(
            checkTimeout,
            async () =>
                await this.resourceInbox.reservations.isTimeoutOnReservedEntries(
                    typeIds,
                    TIMEOUT_ON_NON_RESPONSIVE_ENTRY,
                    maxAttempts
                ),
            false
        );

        const isNewAndRetryEntryToLock: boolean = await this.resourceInbox.reservations.isEntriesToLock(
            typeIds,
            NEW_AND_RETRY_STATUSES,
            maxAttempts
        );
        const finalizationTypes = typeIds.has(EnqueuedType.APP_INBOX)
            ? new Set([EnqueuedType.APP_INBOX])
            : new Set<string>();
        const isFinalizationEntryToLock = await RateLimiter.tryToExecuteOrDefault(
            checkFinalization,
            () =>
                this.resourceInbox.finalization.isRetryExhaustionFinalizationRequired(
                    finalizationTypes,
                    finalizationStaleAfterMs,
                    maxAttempts
                ),
            false
        );

        return isNewAndRetryEntryToLock || isTimedOutReservedEntryToLock || isFinalizationEntryToLock;
    }

    async reserveEntries(
        typeIds: Set<string>,
        statusIds: Set<EntityStatus>,
        reservationInput: ResourceInboxReservationInput
    ): Promise<Map<Key, ResourceEntry>> {
        const options = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        );
        return await this.resourceInbox.transaction(
            async (txRepo: PSqlResourceInboxRepository) => {
                const foundEntries = await txRepo.reservations.findEntriesSkipLocked(typeIds, statusIds, options);

                const reservedEntries = new Map<Key, ResourceEntry>();

                for (const e of foundEntries.values()) {
                    const reserved = await txRepo.reservations.startProcessingEntity(e, options.maxAttempts);
                    reserved.fold(
                        () => undefined,
                        (entry) => {
                            reservedEntries.set(e.key, entry);
                            return undefined;
                        }
                    );
                }

                return reservedEntries;
            }
        );
    }

    async reserveTimeoutEntries(
        typeIds: Set<string>,
        reservationInput: ResourceInboxReservationInput,
        timeSinceStartTs: Temporal.Duration
    ): Promise<Map<Key, ResourceEntry>> {
        const options = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        );
        return await this.resourceInbox.transaction(
            async (txRepo: PSqlResourceInboxRepository) => {
                const foundEntries = await txRepo.reservations.findTimedOutReservedEntriesSkipLocked(
                    typeIds,
                    timeSinceStartTs.total({ unit: 'milliseconds' }),
                    options
                );

                const reservedEntries = new Map<Key, ResourceEntry>();

                for (const e of foundEntries.values()) {
                    const reserved = await txRepo.reservations.startProcessingEntity(e, options.maxAttempts);
                    reserved.fold(
                        () => undefined,
                        (entry) => {
                            reservedEntries.set(e.key, entry);
                            return undefined;
                        }
                    );
                }

                return reservedEntries;
            }
        );
    }

    async reserveOverdueRetryEntries(
        typeIds: Set<string>,
        overdueBeforeEpochMs: number,
        reservationInput: ResourceInboxFairnessReservationInput
    ): Promise<Map<Key, ResourceInboxFairnessSelection>> {
        const options = toResourceInboxFairnessReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        );
        return await this.resourceInbox.transaction(
            async (txRepo: PSqlResourceInboxRepository) => {
                const foundEntries = await txRepo.reservations.findOverdueRetryEntriesSkipLocked(
                    typeIds,
                    overdueBeforeEpochMs,
                    {
                        maxToReserve: options.maxToReserve,
                        maxAttempts: options.maxAttempts
                    }
                );
                const reservedEntries = new Map<Key, ResourceInboxFairnessSelection>();

                for (const entry of foundEntries.values()) {
                    const selectedNextTs = entry.dequeueAudit.nextTs;
                    const reserved = await txRepo.reservations.startProcessingEntity(
                        entry,
                        options.maxAttempts
                    );
                    reserved.fold(
                        () => undefined,
                        (reservedEntry) => {
                            if (!selectedNextTs) {
                                throw new Error('Fairness selector returned an entry without nextTs');
                            }
                            reservedEntries.set(entry.key, {
                                entry: reservedEntry,
                                selectedDueTs: selectedNextTs
                            });
                            return undefined;
                        }
                    );
                }

                return reservedEntries;
            }
        );
    }

    async reserveRetryExhaustionFinalizations(
        typeIds: Set<string>,
        input: ResourceInboxFinalizationReservationOptions
    ): Promise<Map<Key, ResourceInboxFinalizationSelection>> {
        const options = toResourceInboxFinalizationReservationOptions(input);
        const finalizationTypes = typeIds.has(EnqueuedType.APP_INBOX)
            ? new Set([EnqueuedType.APP_INBOX])
            : new Set<string>();
        if (finalizationTypes.size === 0 || options.maxToReserve === 0) {
            return new Map();
        }
        return await this.resourceInbox.transaction(async (txRepo) => {
            const found = await txRepo.finalization.findRetryExhaustionFinalizationsSkipLocked(
                finalizationTypes,
                options.staleAfterMs,
                {
                    processingAttempts: options.processingAttempts,
                    maxToReserve: options.maxToReserve
                }
            );
            const reserved = new Map<Key, ResourceInboxFinalizationSelection>();
            for (const entry of found.values()) {
                const selectedDueTs = entry.dequeueAudit.startTs;
                if (!selectedDueTs) {
                    throw new Error('Finalization selector returned an entry without startTs');
                }
                const recovery = await txRepo.finalization.startFinalizationRecovery(
                    entry,
                    options.processingAttempts
                );
                recovery.fold(
                    () => undefined,
                    (value) => {
                        reserved.set(value.key, { entry: value, selectedDueTs });
                        return undefined;
                    }
                );
            }
            return reserved;
        });
    }

    async releaseEntries(
        resources: ResourceEntry[],
        releaseInput: ResourceInboxReleaseDisposition
    ): Promise<Map<Key, ResourceEntry>> {
        const disposition = toResourceInboxReleaseDisposition(releaseInput);
        const releasedAt = Temporal.Now.instant();
        return await this.resourceInbox.transaction(
            async (txRepo: PSqlResourceInboxRepository) => {
                const releasedEntries = new Map<Key, ResourceEntry>();

                for (const entry of resources) {
                    const updated = await txRepo.reservations.releaseReserved(entry.key, {
                        expectedAttempts: entry.dequeueAudit.attempts,
                        releasedAt,
                        disposition
                    });
                    if (!updated) {
                        const current = await txRepo.entries.findAnyByKey(entry.key);
                        if (
                            !current || !isIdempotentHandlerFinalizedRelease(
                                    current,
                                    entry,
                                    disposition
                                ) && !isAdminPruneHandlerFinalizedRelease(current, entry, disposition)
                        ) {
                            throw new ResourceInboxLostReservationError(
                                entry.key,
                                entry.dequeueAudit.attempts
                            );
                        }
                        releasedEntries.set(entry.key, current);
                        continue;
                    }

                    releasedEntries.set(entry.key, updated);
                }

                return releasedEntries;
            }
        );
    }

    async enqueue(resourceEntry: ResourceEntry): Promise<ResourceEntry | undefined> {
        return await this.resourceInbox.transaction(
            async (txRepo: PSqlResourceInboxRepository) => {
                const previous = await txRepo.entries.findAnyByKey(resourceEntry.key);
                await txRepo.entries.replace(resourceEntry);

                return previous ?? undefined;
            }
        );
    }

    async replaceIfObserved(
        expected: ResourceEntry,
        replacement: ResourceEntry
    ): Promise<ResourceEntry | null> {
        return await this.resourceInbox.entries.replaceIfObserved(expected, replacement);
    }

    async enqueueIfAbsent(resourceEntry: ResourceEntry): Promise<ResourceEntry> {
        return await this.resourceInbox.transaction(
            async (txRepo: PSqlResourceInboxRepository) => {
                return await txRepo.entries.writeIfAbsentOrReplaceExpired(resourceEntry);
            }
        );
    }

    async getItem(key: Key): Promise<ResourceEntry | undefined> {
        return await this.resourceInbox.entries.findByKey(key) ?? undefined;
    }

    async setItem(
        key: Key,
        value: ResourceEntry,
        _options: PersistenceSetItemOptions
    ): Promise<void> {
        await this.resourceInbox.entries.upsert({
            ...value,
            key
        });
    }

    async removeItem(key: Key): Promise<void> {
        await this.resourceInbox.entries.deleteByKey(key);
    }

    async getAllKeys(): Promise<Key[]> {
        return await this.resourceInbox.entries.findAllKeys();
    }

    async deleteExpired(): Promise<number> {
        return await this.resourceInbox.maintenance.deleteExpired();
    }
}
