import { Temporal } from '@js-temporal/polyfill';

import type { PersistenceSetItemOptions } from '@shared/persistence/PersistenceProvider.ts';
import {
    computeResourceInboxRelease,
    toValidatedResourceInboxReleases
} from '@shared/queuebox/compute-resource-inbox-release.ts';
import { hasAdvertisedDequeueWork, type DequeueController } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import {
    isIdempotentHandlerFinalizedRelease,
    ResourceInboxLostReservationError,
    toResourceInboxFairnessReservationOptions,
    toResourceInboxFinalizationReservationOptions,
    toResourceInboxReservationOptions,
    toResourceInboxWorkAdvertisementOptions,
    type QueueBoxResourceEntryRepository,
    type ResourceInboxFairnessReservationInput,
    type ResourceInboxFairnessSelection,
    type ResourceInboxFinalizationReservationOptions,
    type ResourceInboxFinalizationSelection,
    type ResourceInboxRelease,
    type ResourceInboxReleaseDisposition,
    type ResourceInboxReservationRequest,
    type ResourceInboxTimeoutReservationRequest,
    type ResourceInboxWorkAdvertisementOptions,
    type ResourceInboxWorkPage
} from '@shared/queuebox/queue-box-types.ts';
import {
    captureResourceEntryObservations,
    validateResourceEntryObservation
} from '@shared/queuebox/resource-entry-observations.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { toError } from '@shared/resilience/to-error.ts';

import { isAdminPruneHandlerFinalizedRelease } from '../../rallar-system/admin-operations/prune/is-admin-prune-handler-finalized-release.ts';
import type { PSqlResourceInboxRepository } from './create-p-sql-resource-inbox-repository.ts';
import { computeResourceInboxObservedReplacement } from './p-sql-resource-inbox-entry-repository.ts';
import type { ResourceInboxObservedReplacement } from './replace-observed-resource-inbox-entry.ts';
import { computeResourceInboxEntryInsertValues } from './resource-inbox-entry-insert-values.ts';

interface PSqlQueueReleaseCandidate {
    readonly disposition: ResourceInboxReleaseDisposition;
    readonly replacement: ResourceInboxObservedReplacement;
}

export class PSqlQueueBox implements QueueBoxResourceEntryRepository {
    public readonly resourceInbox: PSqlResourceInboxRepository;
    private readonly now: () => Temporal.Instant;

    constructor(
        resourceInbox: PSqlResourceInboxRepository,
        now: () => Temporal.Instant
    ) {
        this.resourceInbox = resourceInbox;
        this.now = now;
    }

    cleanup(): void {
        void this.deleteExpired().catch((error) => {
            console.error('Failed to cleanup expired resource_inbox rows', toError(error));
        });
    }

    async readWorkPage(request: ResourceInboxWorkPage.Request): Promise<ResourceInboxWorkPage> {
        return await this.resourceInbox.reservations.readWorkPage(request);
    }

    /** SQL owns no snapshot across statements here, so the pages are read in order on one connection. */
    async readWorkPages(requests: readonly ResourceInboxWorkPage.Request[]): Promise<readonly ResourceInboxWorkPage[]> {
        const pages: ResourceInboxWorkPage[] = [];
        for (const request of requests) {
            pages.push(await this.readWorkPage(request));
        }
        return pages;
    }

    async readWorkAdvertisement(
        typeIds: Set<string>,
        workInput: ResourceInboxWorkAdvertisementOptions
    ): Promise<DequeueController.WorkAdvertisement> {
        const {
            checkTimeout,
            checkFinalization,
            maxAttempts,
            finalizationStaleAfterMs,
            reservationLeaseMs,
            staleDueThresholdMs
        } = toResourceInboxWorkAdvertisementOptions(workInput);
        const timeoutAdvertised = checkTimeout.allow();
        const finalizationAdvertised = checkFinalization.allow();
        const presence = await this.resourceInbox.reservations.readWorkPresence({
            typeIds,
            maxAttempts,
            reservationLeaseMs,
            finalizationStaleAfterMs,
            staleDueThresholdMs
        });

        return {
            FINALIZATION: finalizationAdvertised && presence.staleExhaustedReservation,
            NEW: presence.newRow,
            RETRY: presence.dueRetry,
            FAIRNESS: presence.overdueRetry,
            TIMEOUT: timeoutAdvertised && presence.timedOutReservation
        };
    }

    async isAnyEntryToLock(
        typeIds: Set<string>,
        workInput: ResourceInboxWorkAdvertisementOptions
    ): Promise<boolean> {
        return hasAdvertisedDequeueWork(await this.readWorkAdvertisement(typeIds, workInput));
    }

    /**
     * A plain claim is one statement in a transaction that only a corrupt selected row rolls back; an
     * observed claim locks the observed rows and compares them with their observations first.
     */
    async reserveEntries(
        { typeIds, statusIds, reservationInput, observedEntries }: ResourceInboxReservationRequest
    ): Promise<Map<Key, ResourceEntry>> {
        const options = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        );
        const observations = captureResourceEntryObservations(observedEntries);
        if (observations === undefined) {
            const claimed = await this.resourceInbox.transaction(async (txRepo) =>
                await txRepo.reservations.reserveEntriesSkipLocked({
                    typeIds,
                    statusIds,
                    reservationInput: options
                })
            );
            return new Map([...claimed.values()].map((entry) => [entry.key, entry]));
        }
        const observedRowIds = [...observations.values()].flatMap((entry) =>
            entry.db === undefined ? [] : [entry.db.id]
        );
        if (observedRowIds.length === 0 || options.maxToReserve === 0) {
            return new Map();
        }
        return await this.resourceInbox.transaction(
            async (txRepo: PSqlResourceInboxRepository) => {
                const foundEntries = await txRepo.reservations.findEntriesSkipLocked({
                    typeIds: typeIds,
                    statusIds: statusIds,
                    reservationInput: options,
                    observedRowIds: observedRowIds
                });

                const reservedEntries = new Map<Key, ResourceEntry>();

                for (const entry of foundEntries.values()) {
                    if (reservedEntries.size >= options.maxToReserve) {
                        break;
                    }
                    if (validateResourceEntryObservation(entry, observations).left) {
                        continue;
                    }
                    const reserved = await txRepo.reservations.startProcessingEntity(entry, options.maxAttempts);
                    reserved.fold(
                        () => undefined,
                        (reservedEntry) => {
                            reservedEntries.set(entry.key, reservedEntry);
                            return undefined;
                        }
                    );
                }

                return reservedEntries;
            }
        );
    }

    async reserveTimeoutEntries(
        { typeIds, reservationInput, timeSinceStartTs, observedEntries }: ResourceInboxTimeoutReservationRequest
    ): Promise<Map<Key, ResourceEntry>> {
        const options = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        );
        const observations = captureResourceEntryObservations(observedEntries);
        const observedRowIds = observations === undefined
            ? undefined
            : [...observations.values()].flatMap((entry) => entry.db === undefined ? [] : [entry.db.id]);
        const timeoutMs = timeSinceStartTs.total({ unit: 'milliseconds' });
        if (observedRowIds?.length === 0 || options.maxToReserve === 0) {
            return new Map();
        }
        return await this.resourceInbox.transaction(
            async (txRepo: PSqlResourceInboxRepository) => {
                const foundEntries = await txRepo.reservations.findTimedOutReservedEntriesSkipLocked({
                    typeIds: typeIds,
                    timeSinceStartMs: timeoutMs,
                    reservationInput: options,
                    observedRowIds: observedRowIds
                });

                const reservedEntries = new Map<Key, ResourceEntry>();

                for (const entry of foundEntries.values()) {
                    if (reservedEntries.size >= options.maxToReserve) {
                        break;
                    }
                    if (validateResourceEntryObservation(entry, observations).left) {
                        continue;
                    }
                    const reserved = await txRepo.reservations.startProcessingEntity(entry, options.maxAttempts);
                    reserved.fold(
                        () => undefined,
                        (reservedEntry) => {
                            reservedEntries.set(entry.key, reservedEntry);
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
        if (typeIds.size === 0 || options.maxToReserve === 0) {
            return new Map();
        }
        return await this.resourceInbox.transaction(async (txRepo) => {
            const found = await txRepo.finalization.findRetryExhaustionFinalizationsSkipLocked(
                typeIds,
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

    async releaseEntries(releases: readonly ResourceInboxRelease[]): Promise<Map<Key, ResourceEntry>> {
        const releasedAt = this.now().round({ smallestUnit: 'microsecond', roundingMode: 'halfEven' });
        const candidates = toPSqlQueueReleaseCandidates(releases, releasedAt);
        return await this.resourceInbox.transaction(
            async (txRepo: PSqlResourceInboxRepository) => {
                const releasedEntries = new Map<Key, ResourceEntry>();

                for (const { disposition, replacement } of candidates) {
                    const entry = replacement.expected.entry;
                    const updated = await txRepo.reservations.releaseReserved(replacement);
                    if (!updated) {
                        const current = await txRepo.entries.findAnyByKey(entry.key);
                        if (
                            !current || !isIdempotentHandlerFinalizedRelease({
                                    current,
                                    reserved: entry,
                                    disposition,
                                    observedAt: releasedAt
                                }) && !isAdminPruneHandlerFinalizedRelease(current, entry, disposition)
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
        const values = computeResourceInboxEntryInsertValues(resourceEntry);
        return await this.resourceInbox.transaction(
            async (txRepo: PSqlResourceInboxRepository) => {
                const previous = await txRepo.entries.findAnyByKey(resourceEntry.key);
                await txRepo.entries.replaceComputed(values);

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
        const values = computeResourceInboxEntryInsertValues(resourceEntry);
        return await this.resourceInbox.transaction(
            async (txRepo: PSqlResourceInboxRepository) => {
                return await txRepo.entries.writeComputedIfAbsentOrReplaceExpired(values);
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

/** Every release of a batch decided before its one transaction opens: validated, then computed. */
function toPSqlQueueReleaseCandidates(
    releases: readonly ResourceInboxRelease[],
    releasedAt: Temporal.Instant
): readonly PSqlQueueReleaseCandidate[] {
    return toValidatedResourceInboxReleases(releases).map((release) => ({
        disposition: release.disposition,
        replacement: computeResourceInboxObservedReplacement(
            release.entry,
            computeResourceInboxRelease(release.entry, release.disposition, releasedAt)
        )
    }));
}
