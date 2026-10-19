import { Temporal } from '@js-temporal/polyfill';
import { toUnavailableReservationObservation } from '@shared/queuebox/resource-inbox/resource-inbox-reservation-observation.ts';
import { toPSqlReservationObservations } from './to-p-sql-reservation-observations.ts';

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
    type ResourceInboxReservationObservationRequest,
    type ResourceInboxReservationObservationResult,
    type ResourceInboxReservationOptions,
    type ResourceInboxReservationRequest,
    type ResourceInboxTimeoutReservationRequest,
    type ResourceInboxWorkAdvertisementOptions,
    type ResourceInboxWorkPage
} from '@shared/queuebox/queue-box-types.ts';
import {
    captureResourceEntryObservations,
    resolveResourceEntryObservation
} from '@shared/queuebox/resource-entry-observations.ts';
import type { EntityStatus, Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { TurnBatchedReads } from '@shared/resilience/turn-batched-reads.ts';

import { isAdminPruneHandlerFinalizedRelease } from '../../rallar-system/admin-operations/prune/is-admin-prune-handler-finalized-release.ts';
import type { PSqlResourceInboxRepository } from './create-p-sql-resource-inbox-repository.ts';
import { computeResourceInboxObservedReplacement } from './p-sql-resource-inbox-entry-repository.ts';
import type {
    ResourceInboxWorkPresence,
    ResourceInboxWorkPresenceRead
} from './read-resource-inbox-work-presences.ts';
import type { ResourceInboxObservedReplacement } from './replace-observed-resource-inbox-entry.ts';
import { computeResourceInboxEntryInsertValues } from './resource-inbox-entry-insert-values.ts';

interface PSqlQueueReleaseCandidate {
    readonly disposition: ResourceInboxReleaseDisposition;
    readonly replacement: ResourceInboxObservedReplacement;
}

interface PSqlObservedReservation {
    readonly typeIds: ReadonlySet<string>;
    readonly statusIds: ReadonlySet<EntityStatus>;
    readonly options: ResourceInboxReservationOptions;
    readonly observations: ReadonlyMap<string, ResourceEntry>;
}

export class PSqlQueueBox implements QueueBoxResourceEntryRepository {
    public readonly resourceInbox: PSqlResourceInboxRepository;
    private readonly now: () => Temporal.Instant;
    /** Every lane's probe of one engine round is one statement. */
    private readonly workPresenceReads: TurnBatchedReads<ResourceInboxWorkPresenceRead, ResourceInboxWorkPresence>;

    constructor(
        resourceInbox: PSqlResourceInboxRepository,
        now: () => Temporal.Instant
    ) {
        this.resourceInbox = resourceInbox;
        this.now = now;
        this.workPresenceReads = new TurnBatchedReads({
            toKeyId: (read) => JSON.stringify([[...read.typeIds].sort(), toWorkPresenceDurations(read)]),
            readBatch: (reads) => resourceInbox.reservations.readWorkPresences(reads)
        });
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
        const { maxAttempts, finalizationStaleAfterMs, reservationLeaseMs, staleDueThresholdMs } =
            toResourceInboxWorkAdvertisementOptions(workInput);
        const presence = await this.workPresenceReads.read({
            typeIds,
            maxAttempts,
            reservationLeaseMs,
            finalizationStaleAfterMs,
            staleDueThresholdMs
        });

        return {
            FINALIZATION: presence.staleExhaustedReservation,
            NEW: presence.newRow,
            RETRY: presence.dueRetry,
            FAIRNESS: presence.overdueRetry,
            TIMEOUT: presence.timedOutReservation
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
    reserveEntries(
        request: ResourceInboxReservationObservationRequest
    ): Promise<ResourceInboxReservationObservationResult>;
    reserveEntries(request: ResourceInboxReservationRequest): Promise<Map<Key, ResourceEntry>>;
    async reserveEntries(
        request: ResourceInboxReservationRequest | ResourceInboxReservationObservationRequest
    ): Promise<Map<Key, ResourceEntry> | ResourceInboxReservationObservationResult> {
        const { typeIds, statusIds, reservationInput, observedEntries, contextClaim } = request;
        if (observedEntries !== undefined && contextClaim !== undefined) {
            throw new TypeError('An observed claim names its rows; it cannot also claim context heads.');
        }
        const options = toResourceInboxReservationOptions(
            reservationInput,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        );
        const observations = captureResourceEntryObservations(observedEntries);
        if (observations === undefined) {
            const claim = { typeIds, statusIds, reservationInput: options, contextClaim };
            if ('reservationObservation' in request) {
                const claimed = await this.resourceInbox.transaction(async (transaction) =>
                    await transaction.reservations.reserveEntriesSkipLocked({
                        ...claim,
                        reservationObservation: request.reservationObservation
                    })
                );
                return {
                    entries: new Map([...claimed.entries.values()].map((entry) => [entry.key, entry])),
                    observations: toPSqlReservationObservations(claimed.observations)
                };
            }
            const claimed = await this.resourceInbox.transaction(async (transaction) =>
                await transaction.reservations.reserveEntriesSkipLocked(claim)
            );
            return new Map([...claimed.values()].map((entry) => [entry.key, entry]));
        }
        const entries = await this.reserveObservedEntries({ typeIds, statusIds, options, observations });
        return 'reservationObservation' in request
            ? {
                entries,
                observations: [...entries.values()].map((entry) =>
                    toUnavailableReservationObservation(entry, 'observed-claim-not-captured')
                )
            }
            : entries;
    }

    private async reserveObservedEntries(
        { typeIds, statusIds, options, observations }: PSqlObservedReservation
    ): Promise<Map<Key, ResourceEntry>> {
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
                    if (resolveResourceEntryObservation(entry, observations).left) {
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
                    if (resolveResourceEntryObservation(entry, observations).left) {
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

function toWorkPresenceDurations(read: ResourceInboxWorkPresenceRead): readonly number[] {
    return [read.maxAttempts, read.reservationLeaseMs, read.finalizationStaleAfterMs, read.staleDueThresholdMs];
}
