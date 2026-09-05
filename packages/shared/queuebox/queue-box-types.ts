import { Temporal } from '@js-temporal/polyfill';
import { EnqueuedType } from '../api/api-config.ts';
import type { PersistenceProvider } from '../persistence/PersistenceProvider.ts';
import { RateLimiter } from '../resilience/Resilience.ts';
import {
    COALESCED_APP_OUTBOX_WORK_FIELD,
    tryReadCoalescedAppOutboxWorkEnvelope
} from './coalesced-app-outbox-work-envelope.ts';
import {
    hasSameGroupPresenceSummaryImmutableEntry,
    isCanonicalGroupPresenceSummaryEntry
} from './GroupPresenceSummaryEntryContract.ts';
import * as Resource from './ResourceEntry.ts';
import { ResourceEntry, type Key } from './ResourceEntry.ts';
import { isCanonicalRtcTopologyWorkEntry } from './rtc-topology-work-entry-contract.ts';

export type { PersistenceProvider } from '../persistence/PersistenceProvider.ts';

export type ResourceInboxReservationOptions = Readonly<{
    maxToReserve: number;
    maxAttempts: number;
}>;

export type ResourceInboxReservationInput = number | ResourceInboxReservationOptions;

export type ResourceInboxFairnessReservationOptions =
    & ResourceInboxReservationOptions
    & Readonly<{
        maxToScan: number;
    }>;

export type ResourceInboxFairnessReservationInput =
    | number
    | ResourceInboxFairnessReservationOptions;

export type ResourceInboxFinalizationReservationOptions = Readonly<{
    processingAttempts: number;
    maxToReserve: number;
    staleAfterMs: number;
}>;

// Exhaustion recovery deliberately excludes expired rows. Queue cleanup owns
// their terminal deletion; recovery never revives an expired command.

export type ResourceInboxWorkAdvertisementOptions = Readonly<{
    checkTimeout: RateLimiter;
    checkFairness: RateLimiter;
    checkFinalization: RateLimiter;
    maxAttempts: number;
    finalizationStaleAfterMs: number;
}>;

export type ResourceInboxTerminalReleaseStatus =
    | typeof Resource.EntityStatus.COMPLETED
    | typeof Resource.EntityStatus.FAILED
    | typeof Resource.EntityStatus.ABORTED
    | typeof Resource.EntityStatus.NON_RETRYABLE
    | typeof Resource.EntityStatus.PARTITIONED
    | typeof Resource.EntityStatus.MERGED;

export type ResourceInboxReleaseDisposition =
    | Readonly<{
        status: typeof Resource.EntityStatus.RETRY;
        delayMs: number;
    }>
    | Readonly<{
        status: ResourceInboxTerminalReleaseStatus;
        delayMs: null;
    }>;

export type ResourceInboxFairnessSelection = Readonly<{
    entry: ResourceEntry;
    selectedDueTs: Temporal.Instant;
}>;

export type ResourceInboxFinalizationSelection = Readonly<{
    entry: ResourceEntry;
    selectedDueTs: Temporal.Instant;
}>;

export class ResourceInboxLostReservationError extends Error {
    readonly code = 'resource-inbox-lost-reservation';

    readonly key: Key;
    readonly expectedAttempts: number;

    constructor(
        key: Key,
        expectedAttempts: number
    ) {
        super(
            `Resource inbox reservation was lost before release: ${JSON.stringify(key)}`
        );
        this.key = key;
        this.expectedAttempts = expectedAttempts;
        this.name = 'ResourceInboxLostReservationError';
    }
}

export class ResourceInboxInvalidReleaseDispositionError extends Error {
    readonly code = 'resource-inbox-invalid-release-disposition';

    constructor() {
        super('Resource inbox release disposition is invalid');
        this.name = 'ResourceInboxInvalidReleaseDispositionError';
    }
}

export function isIdempotentHandlerFinalizedRelease(
    current: ResourceEntry,
    reserved: ResourceEntry,
    disposition: ResourceInboxReleaseDisposition
): boolean {
    try {
        if (isCoalescedRevivalAfterHandlerFinalization(current, reserved, disposition)) {
            return true;
        }
        const remoteDeliveryRequeue = disposition.status === Resource.EntityStatus.COMPLETED &&
            disposition.delayMs === null &&
            reserved.typeId === EnqueuedType.WS_OUTBOX &&
            reserved.status === Resource.EntityStatus.RESERVED &&
            current.status === Resource.EntityStatus.RETRY &&
            current.typeId === reserved.typeId &&
            current.resource === reserved.resource &&
            Resource.isKeysEqual(current.key, reserved.key) &&
            current.dequeueAudit.attempts === reserved.dequeueAudit.attempts &&
            !Resource.isExpiredResourceEntry(current);
        if (remoteDeliveryRequeue) {
            return true;
        }
        const commonFinalization = disposition.status === Resource.EntityStatus.COMPLETED &&
            disposition.delayMs === null &&
            reserved.status === Resource.EntityStatus.RESERVED &&
            current.typeId === reserved.typeId &&
            current.status === Resource.EntityStatus.COMPLETED &&
            Resource.isKeysEqual(current.key, reserved.key) &&
            current.dequeueAudit.attempts === reserved.dequeueAudit.attempts &&
            !Resource.isExpiredResourceEntry(current);
        if (!commonFinalization) {
            return false;
        }
        if (reserved.typeId === EnqueuedType.APP_INBOX) {
            return true;
        }

        if (
            reserved.typeId !== EnqueuedType.APP_OUTBOX ||
            current.resource !== reserved.resource
        ) {
            return false;
        }

        if (
            isCanonicalGroupPresenceSummaryEntry(reserved) &&
            isCanonicalGroupPresenceSummaryEntry(current)
        ) {
            return hasSameGroupPresenceSummaryImmutableEntry(current, reserved);
        }

        return isCanonicalRtcTopologyWorkEntry(reserved) &&
            isCanonicalRtcTopologyWorkEntry(current);
    }
    catch {
        return false;
    }
}

/**
 * A coalesced APP_OUTBOX row may be revived in place after a handler finalized
 * the reserved work: the revival compare-and-set matches only terminal
 * statuses, so a same-key row whose coalesced generation advanced past the
 * reserved entry's with a reset dequeue lifecycle proves the reservation was
 * finalized first and then legitimately superseded. Releasing that
 * reservation as completed is idempotent, not a lost reservation.
 */
function isCoalescedRevivalAfterHandlerFinalization(
    current: ResourceEntry,
    reserved: ResourceEntry,
    disposition: ResourceInboxReleaseDisposition
): boolean {
    if (
        disposition.status !== Resource.EntityStatus.COMPLETED ||
        disposition.delayMs !== null ||
        reserved.status !== Resource.EntityStatus.RESERVED ||
        reserved.typeId !== EnqueuedType.APP_OUTBOX ||
        current.typeId !== EnqueuedType.APP_OUTBOX ||
        !Resource.isKeysEqual(current.key, reserved.key) ||
        (current.status !== Resource.EntityStatus.NEW &&
            current.status !== Resource.EntityStatus.RETRY) ||
        current.dequeueAudit.attempts !== 0
    ) {
        return false;
    }
    const reservedWork = tryReadCoalescedAppOutboxWorkEnvelope(reserved);
    const currentWork = tryReadCoalescedAppOutboxWorkEnvelope(current);
    return reservedWork !== undefined &&
        currentWork !== undefined &&
        currentWork.data[COALESCED_APP_OUTBOX_WORK_FIELD].generation >
            reservedWork.data[COALESCED_APP_OUTBOX_WORK_FIELD].generation;
}

export function toResourceInboxReservationOptions(
    input: ResourceInboxReservationInput,
    defaultMaxAttempts: number
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

export function toResourceInboxFairnessReservationOptions(
    input: ResourceInboxFairnessReservationInput,
    defaultMaxAttempts: number
): ResourceInboxFairnessReservationOptions {
    const reservation = toResourceInboxReservationOptions(input, defaultMaxAttempts);
    const maxToScan = typeof input === 'number'
        ? toSaturatedResourceInboxFairnessScanBudget(reservation.maxToReserve)
        : input.maxToScan;

    if (!Number.isSafeInteger(maxToScan) || maxToScan < 0) {
        throw new Error('maxToScan must be a non-negative safe integer');
    }

    return { ...reservation, maxToScan };
}

export function toSaturatedResourceInboxFairnessScanBudget(
    maxToReserve: number
): number {
    if (!Number.isSafeInteger(maxToReserve) || maxToReserve < 0) {
        throw new Error('maxToReserve must be a non-negative safe integer');
    }

    return maxToReserve > Math.floor(Number.MAX_SAFE_INTEGER / 8)
        ? Number.MAX_SAFE_INTEGER
        : maxToReserve * 8;
}

export function toResourceInboxFinalizationReservationOptions(
    input: ResourceInboxFinalizationReservationOptions
): ResourceInboxFinalizationReservationOptions {
    if (!Number.isSafeInteger(input.processingAttempts) || input.processingAttempts < 1) {
        throw new Error('processingAttempts must be a positive safe integer');
    }
    if (!Number.isSafeInteger(input.maxToReserve) || input.maxToReserve < 0) {
        throw new Error('maxToReserve must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(input.staleAfterMs) || input.staleAfterMs < 0) {
        throw new Error('staleAfterMs must be a non-negative safe integer');
    }
    return input;
}

export function toResourceInboxWorkAdvertisementOptions(
    input: unknown
): ResourceInboxWorkAdvertisementOptions {
    if (
        typeof input !== 'object' ||
        input === null ||
        !('maxAttempts' in input) ||
        typeof input.maxAttempts !== 'number' ||
        !Number.isSafeInteger(input.maxAttempts) ||
        input.maxAttempts < 1
    ) {
        throw new Error('maxAttempts must be a positive safe integer');
    }
    if (
        !('finalizationStaleAfterMs' in input) ||
        typeof input.finalizationStaleAfterMs !== 'number' ||
        !Number.isSafeInteger(input.finalizationStaleAfterMs) ||
        input.finalizationStaleAfterMs < 0
    ) {
        throw new Error('finalizationStaleAfterMs must be a non-negative safe integer');
    }
    if (
        !('checkTimeout' in input) || !(input.checkTimeout instanceof RateLimiter) ||
        !('checkFairness' in input) || !(input.checkFairness instanceof RateLimiter) ||
        !('checkFinalization' in input) || !(input.checkFinalization instanceof RateLimiter)
    ) {
        throw new Error('work advertisement checks must be rate limiters');
    }

    return {
        checkTimeout: input.checkTimeout,
        checkFairness: input.checkFairness,
        checkFinalization: input.checkFinalization,
        maxAttempts: input.maxAttempts,
        finalizationStaleAfterMs: input.finalizationStaleAfterMs
    };
}

export function toResourceInboxReleaseDisposition(
    input: unknown
): ResourceInboxReleaseDisposition {
    if (typeof input !== 'object' || input === null) {
        throw new ResourceInboxInvalidReleaseDispositionError();
    }
    const status = 'status' in input ? input.status : undefined;
    const delayMs = 'delayMs' in input ? input.delayMs : undefined;
    if (
        status === Resource.EntityStatus.RETRY &&
        typeof delayMs === 'number' &&
        Number.isSafeInteger(delayMs) &&
        delayMs >= 1
    ) {
        return { status, delayMs };
    }

    if (delayMs === null) {
        switch (status) {
            case Resource.EntityStatus.COMPLETED:
            case Resource.EntityStatus.FAILED:
            case Resource.EntityStatus.ABORTED:
            case Resource.EntityStatus.NON_RETRYABLE:
            case Resource.EntityStatus.PARTITIONED:
            case Resource.EntityStatus.MERGED:
                return { status, delayMs };
        }
    }

    throw new ResourceInboxInvalidReleaseDispositionError();
}

export interface DequeueResourceEntryRepository {
    isAnyEntryToLock(
        typeIds: Set<string>,
        workOptions: ResourceInboxWorkAdvertisementOptions
    ): Promise<boolean>;

    reserveEntries(
        typeIds: Set<string>,
        statusIds: Set<Resource.EntityStatus>,
        options: ResourceInboxReservationInput
    ): Promise<Map<Resource.Key, Resource.ResourceEntry>>;

    reserveTimeoutEntries(
        typeIds: Set<string>,
        options: ResourceInboxReservationInput,
        timeSinceStartTs: Temporal.Duration
    ): Promise<Map<Resource.Key, Resource.ResourceEntry>>;

    reserveOverdueRetryEntries(
        typeIds: Set<string>,
        overdueBeforeEpochMs: number,
        options: ResourceInboxFairnessReservationInput
    ): Promise<Map<Resource.Key, ResourceInboxFairnessSelection>>;

    reserveRetryExhaustionFinalizations(
        typeIds: Set<string>,
        options: ResourceInboxFinalizationReservationOptions
    ): Promise<Map<Resource.Key, ResourceInboxFinalizationSelection>>;

    releaseEntries(
        resources: Resource.ResourceEntry[],
        disposition: ResourceInboxReleaseDisposition
    ): Promise<Map<Resource.Key, Resource.ResourceEntry>>;
}

export interface EnqueueResourceEntryController {
    enqueueIfAbsent(resourceEntry: ResourceEntry): Promise<ResourceEntry>;

    replaceIfObserved(
        expected: ResourceEntry,
        replacement: ResourceEntry
    ): Promise<ResourceEntry | null>;

    enqueue(resourceEntry: ResourceEntry): Promise<ResourceEntry | undefined>;

    cleanup(): void;
}

export interface EnqueueBoxResourceEntryRepository extends EnqueueResourceEntryController {
    findByKey(key: Key): Promise<ResourceEntry | undefined>;
}

export interface QueueBoxResourceEntryRepository
    extends
        DequeueResourceEntryRepository,
        EnqueueResourceEntryController,
        PersistenceProvider<Resource.Key, Resource.ResourceEntry> {
}
