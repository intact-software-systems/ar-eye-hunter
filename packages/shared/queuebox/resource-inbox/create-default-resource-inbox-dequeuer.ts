import { Temporal } from '@js-temporal/polyfill';

import { RateLimiter } from '../../resilience/Resilience.ts';
import { toErrorSummary } from '../../resilience/to-error.ts';
import { toDequeuedKeyText } from '../dequeue/dequeue-batch.ts';
import { DequeueController, Reservator } from '../dequeue/dequeue-controller.ts';
import {
    toSaturatedResourceInboxFairnessScanBudget,
    type DequeueResourceEntryRepository,
    type ResourceInboxClaimOrder,
    type ResourceInboxContextClaim,
    type ResourceInboxFinalizationSelection,
    type ResourceInboxReleaseDisposition
} from '../queue-box-types.ts';
import { hasSameResourceEntryValue } from '../resource-entry-observations.ts';
import * as Resource from '../ResourceEntry.ts';
import {
    EntityStatus,
    isKeysEqual,
    type ResourceEntry
} from '../ResourceEntry.ts';
import {
    retryAfterAttempt,
    toResourceInboxFairnessTelemetry,
    type ResourceInboxFairnessTelemetry,
    type ResourceInboxRetryPolicy
} from '../ResourceInboxRetryPolicy.ts';
import { isNotReadyException, NotReadyException } from './not-ready-exception.ts';
import {
    computeResourceInboxAttempt,
    recordResourceInboxAttemptRelease,
    toResourceInboxAttemptFailureCause,
    type ResourceInboxAttempt,
    type ResourceInboxAttemptFailureCause,
    type ResourceInboxAttemptReleaseTelemetry
} from './resource-inbox-attempt-telemetry.ts';
import type { ResourceInboxCompletionNotifications } from './resource-inbox-completion-notifications.ts';
import { ResourceInboxResilience } from './resource-inbox-resilience.ts';

const RESOURCE_INBOX_COMPLETION_STATUSES: ReadonlySet<EntityStatus> = new Set([
    EntityStatus.COMPLETED,
    EntityStatus.FAILED,
    EntityStatus.NON_RETRYABLE
]);

export class NonRetryableException extends Error {
    constructor(message?: string) {
        super(message);
        this.name = 'NonRetryableException';
    }
}

export interface ResourceInboxRetryExhaustion {
    readonly entry: ResourceEntry;
    readonly processingAttempts: number;
    readonly reservationAttempt: number;
    readonly lane: Reservator;
    readonly classification: 'retryable';
    readonly exhausted: true;
    readonly failure: Readonly<{ source: 'processing'; error: Error; }>;
    readonly queueAgeMs: number;
    readonly dueAgeMs: number;
    readonly exhaustedAtEpochMs: number;
}

export interface ResourceInboxRetryExhaustionRecovery {
    readonly entry: ResourceEntry;
    readonly processingAttempts: number;
    readonly reservationAttempt: number;
    readonly lane: typeof Reservator.FINALIZATION;
    readonly classification: 'retryable';
    readonly exhausted: true;
    readonly failure: Readonly<{ source: 'finalization-recovery'; }>;
    readonly queueAgeMs: number;
    readonly dueAgeMs: number;
    readonly selectedDueAtEpochMs: number;
    readonly finalizedAtEpochMs: number;
}

/**
 * Called once for a claimed exhausted attempt or recovery reservation. The finalizer owns its
 * transaction and resolves with the same key's terminal entry only after commit. Rejection leaves
 * publication and recovery to the queue; the callback must not retry a stale attempt internally.
 */
export type ResourceInboxRetryFinalizer<
    Finalization extends ResourceInboxRetryExhaustion | ResourceInboxRetryExhaustionRecovery,
> = (
    finalization: Finalization
) => Promise<ResourceEntry>;

/** A handler failure carrying its persisted entry; one no longer RESERVED was finalized and announced by its committer. */
export class ResourceInboxHandlerEntryError extends Error {
    readonly code = 'resource-inbox-handler-entry-updated';

    readonly #entry: ResourceEntry;
    readonly #handlerError: Error;

    constructor(
        entry: ResourceEntry,
        handlerError: Error
    ) {
        super('Resource inbox handler returned a persisted entry after failure', {
            cause: handlerError
        });
        this.#entry = entry;
        this.#handlerError = handlerError;
        this.name = 'ResourceInboxHandlerEntryError';
    }

    get entry(): ResourceEntry {
        return this.#entry;
    }

    get handlerError(): Error {
        return this.#handlerError;
    }
}

/**
 * A handler success whose own transaction already committed the terminal entry, so the queue releases nothing and
 * publishes no completion notice: the committer published it.
 */
export class ResourceInboxHandlerFinalizedSuccess {
    readonly entry: ResourceEntry;

    constructor(entry: ResourceEntry) {
        this.entry = entry;
    }
}

/**
 * A handler's typed rejection whose own transaction already committed the terminal entry: a value, not an operational
 * failure. The queue releases nothing, records the attempt as non-retryable and logs the rejection's cause chain.
 */
export class ResourceInboxHandlerFinalizedRejection {
    readonly entry: ResourceEntry;
    readonly code: string;
    readonly cause: Error;

    constructor(entry: ResourceEntry, code: string, cause: Error) {
        this.entry = entry;
        this.code = code;
        this.cause = cause;
    }
}

export type ResourceInboxHandlerFinalized =
    | ResourceInboxHandlerFinalizedSuccess
    | ResourceInboxHandlerFinalizedRejection;

/**
 * A handler's optimistic conflict that committed nothing: a value, not an operational failure. The queue releases the
 * still-reserved entry on the retry path, with its attempt count and backoff, and logs the cause chain once.
 */
export class ResourceInboxHandlerRetryableConflict {
    readonly entry: ResourceEntry;
    readonly code: string;
    readonly cause: Error;

    constructor(entry: ResourceEntry, code: string, cause: Error) {
        this.entry = entry;
        this.code = code;
        this.cause = cause;
    }
}

export type ResourceInboxHandlerOutcome = ResourceInboxHandlerFinalized | ResourceInboxHandlerRetryableConflict;

export interface ResourceInboxDequeuerInput {
    readonly repository: DequeueResourceEntryRepository;
    readonly typesToDequeue: () => Set<string>;
    /** The order the NEW lane claims in; the other lanes always claim in queue order. */
    readonly newLaneClaimOrder: ResourceInboxClaimOrder;
    readonly maxToReserve: () => number;
    readonly maxNumToDequeue: number;
    readonly readLaneBudgets?: DequeueController.ReadLaneBudgets;
    /** The probe that preceded this pass; without one every lane is offered a reservation. */
    readonly workAdvertisement?: DequeueController.WorkAdvertisement;
    readonly resilience: ResourceInboxResilience;
    readonly options?: DequeueResourceEntryOptions;
}

export interface DequeueResourceEntryOptions {
    readonly completionNotifications?: ResourceInboxCompletionNotifications;
    /** Whether a caller can wait for a released entry's completion; absent, every completion is awaitable. */
    readonly toCompletionAwaitability?: (entry: ResourceEntry) => ResourceInboxCompletionNotifications.Awaitability;
    /** Recognizes an expected optimistic conflict: it retries the entry without counting as an operational failure. */
    readonly isRetryableConflict?: (error: Error) => boolean;
    readonly jitterUnit?: () => number;
    readonly nowEpochMs?: () => number;
    readonly onReservationTelemetry?: (event: ResourceInboxFairnessTelemetry) => void;
    readonly onAttemptReleaseTelemetry?: (event: ResourceInboxAttemptReleaseTelemetry) => void;
    readonly onRetryExhausted?: ResourceInboxRetryFinalizer<ResourceInboxRetryExhaustion>;
    readonly onRetryExhaustionTelemetry?: (
        exhaustion: ResourceInboxRetryExhaustion | ResourceInboxRetryExhaustionRecovery
    ) => void;
    readonly onRetryExhaustionRecovery?: ResourceInboxRetryFinalizer<ResourceInboxRetryExhaustionRecovery>;
}

interface ResourceInboxDequeueDependencies {
    readonly repository: DequeueResourceEntryRepository;
    readonly resilience: ResourceInboxResilience;
    readonly options: DequeueResourceEntryOptions;
    readonly nowEpochMs: () => number;
    readonly jitterUnit: () => number;
    readonly recordReservationTelemetry: (event: ResourceInboxFairnessTelemetry) => void;
}

interface ResourceInboxReservationSelection {
    readonly types: Set<string>;
    readonly maxToReserve: number;
    readonly lane: typeof Reservator.NEW | typeof Reservator.RETRY;
    /** Absent claims in queue order. */
    readonly contextClaim: ResourceInboxContextClaim | undefined;
}

interface ResourceInboxReleasedSuccess<V> {
    readonly original: DequeueController.Success<Resource.Key, ResourceInboxAttempt, V>;
    readonly entry: ResourceEntry;
    readonly classification: 'accepted' | 'non-retryable';
    readonly failure: ResourceInboxAttemptFailureCause | undefined;
}

interface ResourceInboxFailureDecision {
    readonly classification: 'not-ready' | 'retryable' | 'non-retryable';
    readonly disposition: ResourceInboxReleaseDisposition;
    readonly exhausted: boolean;
}

export function createDefaultResourceInboxDequeuer<V>(
    input: ResourceInboxDequeuerInput
): DequeueController<Resource.Key, ResourceInboxAttempt, V> {
    const options = input.options ?? {};
    const dependencies: ResourceInboxDequeueDependencies = {
        repository: input.repository,
        resilience: input.resilience,
        options,
        nowEpochMs: options.nowEpochMs ?? Date.now,
        jitterUnit: options.jitterUnit ?? Math.random,
        recordReservationTelemetry: options.onReservationTelemetry ?? recordResourceInboxReservation
    };
    // One pass serves a context's head at most once: its next row waits for the next pass.
    const servedNewContextIds = new Set<string>();
    const newContextClaim = input.newLaneClaimOrder === 'oldest-per-context'
        ? { excludedContextIds: servedNewContextIds }
        : undefined;
    return createResourceInboxFinalizationController<V>(dependencies, input)
        .onNewEntriesReserveDo(async (types, maxToReserve) => {
            const attempts = await reserveResourceInboxAttempts(dependencies, {
                types,
                maxToReserve,
                lane: Reservator.NEW,
                contextClaim: newContextClaim
            });
            for (const key of attempts.keys()) {
                servedNewContextIds.add(key.contextId);
            }
            return attempts;
        })
        .onRetryEntriesReserveDo((types, maxToReserve) =>
            reserveResourceInboxAttempts(dependencies, {
                types,
                maxToReserve,
                lane: Reservator.RETRY,
                contextClaim: undefined
            })
        )
        .onFairnessEntriesReserveDo((types, maxToReserve) =>
            reserveResourceInboxFairness(dependencies, types, maxToReserve)
        )
        .onTimeoutEntriesReserveDo((types, maxToReserve) =>
            reserveResourceInboxTimeouts(dependencies, types, maxToReserve)
        )
        .onReleaseEntriesDo(
            (successes) => releaseResourceInboxSuccesses(dependencies, successes),
            (failures) => releaseResourceInboxFailures(dependencies, failures)
        );
}

function createResourceInboxFinalizationController<V>(
    dependencies: ResourceInboxDequeueDependencies,
    input: ResourceInboxDequeuerInput
): DequeueController<Resource.Key, ResourceInboxAttempt, V> {
    return DequeueController.create<Resource.Key, ResourceInboxAttempt, V>()
        .withInboxTypesToDequeue(input.typesToDequeue)
        .withMaxNumToDequeue(input.maxNumToDequeue)
        .withLaneBudgets(input.readLaneBudgets)
        .withWorkAdvertisement(input.workAdvertisement)
        .withMaxNumToReserve(input.maxToReserve)
        .onFinalizationEntriesReserveDo(
            dependencies.options.onRetryExhaustionRecovery
                ? (types, maxToReserve) => reserveResourceInboxFinalizations(dependencies, types, maxToReserve)
                : undefined
        )
        .onFinalizationEntriesDo(
            dependencies.options.onRetryExhaustionRecovery
                ? async (key, attempt) => {
                    await finalizeResourceInboxRecovery(dependencies, attempt);
                    return key;
                }
                : undefined
        );
}

async function reserveResourceInboxAttempts(
    dependencies: ResourceInboxDequeueDependencies,
    selection: ResourceInboxReservationSelection
): Promise<Map<Resource.Key, ResourceInboxAttempt>> {
    const entries = await dependencies.repository.reserveEntries({
        typeIds: selection.types,
        statusIds: new Set([selection.lane === Reservator.NEW ? EntityStatus.NEW : EntityStatus.RETRY]),
        reservationInput: {
            maxToReserve: selection.maxToReserve,
            maxAttempts: dependencies.resilience.retryPolicy.maxAttempts
        },
        contextClaim: selection.contextClaim
    });
    return toResourceInboxAttempts(dependencies, entries, selection.lane);
}

async function reserveResourceInboxTimeouts(
    dependencies: ResourceInboxDequeueDependencies,
    types: Set<string>,
    maxToReserve: number
): Promise<Map<Resource.Key, ResourceInboxAttempt>> {
    const entries = await RateLimiter.tryToExecuteOrDefault(
        dependencies.resilience.checkReserveTimeouts.lockEntryRateLimiter,
        () =>
            dependencies.repository.reserveTimeoutEntries({
                typeIds: types,
                reservationInput: { maxToReserve, maxAttempts: dependencies.resilience.retryPolicy.maxAttempts },
                timeSinceStartTs: Temporal.Duration.from({
                    milliseconds: dependencies.resilience.reservationLeaseMs
                })
            }),
        new Map<Resource.Key, ResourceEntry>()
    );
    if (entries.size > 0) {
        console.info('Reserved timed-out resource inbox entries', [...entries.keys()]);
    }
    return toResourceInboxAttempts(dependencies, entries, Reservator.TIMEOUT);
}

/** An overdue row is claimed on this pass, ahead of RETRY; the probe answered whether one exists. */
async function reserveResourceInboxFairness(
    dependencies: ResourceInboxDequeueDependencies,
    types: Set<string>,
    maxToReserve: number
): Promise<Map<Resource.Key, ResourceInboxAttempt>> {
    const selectedAtEpochMs = dependencies.nowEpochMs();
    const policy = dependencies.resilience.retryPolicy;
    const selections = await dependencies.repository.reserveOverdueRetryEntries(
        types,
        selectedAtEpochMs - policy.staleDueThresholdMs,
        {
            maxToReserve,
            maxAttempts: policy.maxAttempts,
            maxToScan: Math.max(types.size, toSaturatedResourceInboxFairnessScanBudget(maxToReserve))
        }
    );
    const attempts = new Map<Resource.Key, ResourceInboxAttempt>();
    for (const [key, selection] of selections) {
        dependencies.recordReservationTelemetry(toResourceInboxFairnessTelemetry(selection, selectedAtEpochMs));
        attempts.set(
            key,
            computeResourceInboxAttempt({
                entry: selection.entry,
                selectedLane: Reservator.FAIRNESS,
                selectedAtEpochMs,
                selectedDueAtEpochMs: Number(selection.selectedDueTs.epochMilliseconds),
                reservationLeaseMs: dependencies.resilience.reservationLeaseMs
            })
        );
    }
    return attempts;
}

async function reserveResourceInboxFinalizations(
    dependencies: ResourceInboxDequeueDependencies,
    types: Set<string>,
    maxToReserve: number
): Promise<Map<Resource.Key, ResourceInboxAttempt>> {
    const selectedAtEpochMs = dependencies.nowEpochMs();
    const selections = await RateLimiter.tryToExecuteOrDefault(
        dependencies.resilience.checkFinalization.lockEntryRateLimiter,
        () =>
            dependencies.repository.reserveRetryExhaustionFinalizations(types, {
                processingAttempts: dependencies.resilience.retryPolicy.maxAttempts,
                maxToReserve,
                staleAfterMs: ResourceInboxResilience.FINALIZATION_STALE_AFTER_MS
            }),
        new Map<Resource.Key, ResourceInboxFinalizationSelection>()
    );
    return new Map([...selections].map(([key, selection]) => [
        key,
        computeResourceInboxAttempt({
            entry: selection.entry,
            selectedLane: Reservator.FINALIZATION,
            selectedAtEpochMs,
            selectedDueAtEpochMs: Number(selection.selectedDueTs.epochMilliseconds),
            reservationLeaseMs: dependencies.resilience.reservationLeaseMs
        })
    ]));
}

async function finalizeResourceInboxRecovery(
    dependencies: ResourceInboxDequeueDependencies,
    attempt: ResourceInboxAttempt
): Promise<void> {
    const recovery = toRetryExhaustionRecovery(
        attempt,
        dependencies.resilience.retryPolicy.maxAttempts,
        dependencies.nowEpochMs()
    );
    const finalized = await dependencies.options.onRetryExhaustionRecovery!(recovery);
    publishResourceInboxCompletion(dependencies.options, finalized);
    dependencies.options.onRetryExhaustionTelemetry?.(recovery);
}

async function releaseResourceInboxSuccesses<V>(
    dependencies: ResourceInboxDequeueDependencies,
    successes: Map<Resource.Key, DequeueController.Success<Resource.Key, ResourceInboxAttempt, V>>
): Promise<Map<Resource.Key, DequeueController.Success<Resource.Key, ResourceInboxAttempt, V>>> {
    const reserved = [...successes.values()].filter((success) =>
        !isHandlerFinalized(success.computedValue) &&
        !(success.computedValue instanceof ResourceInboxHandlerRetryableConflict)
    );
    const released = reserved.length === 0 ? new Map<Resource.Key, ResourceEntry>() : await dependencies.repository
        .releaseEntries(reserved.map((success) => ({
            entry: success.value.entry,
            disposition: { status: EntityStatus.COMPLETED, delayMs: null }
        })));
    const handlerFinalized = [...successes.values()].flatMap((success) =>
        isHandlerFinalized(success.computedValue)
            ? [toHandlerFinalizedResourceInboxRelease(success, success.computedValue)]
            : []
    );
    const releasedByQueue = [...released].map(([key, entry]) => toReleasedResourceInboxSuccess(key, entry, successes));
    for (const { entry } of releasedByQueue) {
        publishResourceInboxCompletion(dependencies.options, entry);
    }
    const releases = [...handlerFinalized, ...releasedByQueue];
    const result = await releaseResourceInboxConflicts(dependencies, successes);
    for (const { original, entry, classification, failure } of releases) {
        recordResourceInboxAttemptRelease(dependencies.options.onAttemptReleaseTelemetry, {
            attempt: original.value,
            released: entry,
            classification,
            failure
        });
        result.set(original.key, {
            key: original.key,
            value: { ...original.value, entry },
            computedValue: original.computedValue
        });
    }
    return result;
}

/** A conflict value follows the failure release of the entry it carries, so it retries or exhausts like a thrown one. */
async function releaseResourceInboxConflicts<V>(
    dependencies: ResourceInboxDequeueDependencies,
    successes: Map<Resource.Key, DequeueController.Success<Resource.Key, ResourceInboxAttempt, V>>
): Promise<Map<Resource.Key, DequeueController.Success<Resource.Key, ResourceInboxAttempt, V>>> {
    const result = new Map<Resource.Key, DequeueController.Success<Resource.Key, ResourceInboxAttempt, V>>();
    for (const success of successes.values()) {
        const conflict = success.computedValue;
        if (!(conflict instanceof ResourceInboxHandlerRetryableConflict)) {
            continue;
        }
        console.info(
            `Handler conflicted on dequeued key ${
                toDequeuedKeyText(success.key)
            } as ${conflict.code}; it is redelivered.`,
            toErrorSummary(conflict.cause)
        );
        const released = await releaseResourceInboxFailure(dependencies, {
            key: success.key,
            value: success.value,
            exception: new ResourceInboxHandlerEntryError(conflict.entry, conflict.cause)
        });
        if (released !== undefined) {
            result.set(success.key, { key: success.key, value: released.value, computedValue: success.computedValue });
        }
    }
    return result;
}

async function releaseResourceInboxFailures(
    dependencies: ResourceInboxDequeueDependencies,
    failures: Map<Resource.Key, DequeueController.Failure<Resource.Key, ResourceInboxAttempt>>
): Promise<Map<Resource.Key, DequeueController.Failure<Resource.Key, ResourceInboxAttempt>>> {
    const result = new Map<Resource.Key, DequeueController.Failure<Resource.Key, ResourceInboxAttempt>>();
    for (const original of failures.values()) {
        const released = await releaseResourceInboxFailure(dependencies, original);
        if (released !== undefined) {
            result.set(released.key, released);
        }
    }
    return result;
}

async function releaseResourceInboxFailure(
    dependencies: ResourceInboxDequeueDependencies,
    original: DequeueController.Failure<Resource.Key, ResourceInboxAttempt>
): Promise<DequeueController.Failure<Resource.Key, ResourceInboxAttempt> | undefined> {
    const failure = toHandlerEntryFailure(original);
    if (
        original.exception instanceof ResourceInboxHandlerEntryError &&
        failure.value.entry.status !== EntityStatus.RESERVED
    ) {
        recordResourceInboxAttemptRelease(dependencies.options.onAttemptReleaseTelemetry, {
            attempt: original.value,
            released: failure.value.entry,
            classification: failure.value.entry.status === EntityStatus.COMPLETED ? 'accepted' : 'non-retryable',
            failure: toResourceInboxAttemptFailureCause(failure.exception)
        });
        return failure;
    }
    const decision = computeResourceInboxFailureDecision(
        failure,
        dependencies.resilience.retryPolicy,
        dependencies.jitterUnit()
    );
    const entry = decision.exhausted && dependencies.options.onRetryExhausted
        ? await finalizeResourceInboxFailure(dependencies, failure)
        : [...(await dependencies.repository.releaseEntries([
            { entry: failure.value.entry, disposition: decision.disposition }
        ])).values()][0];
    if (entry === undefined) {
        return undefined;
    }
    if (!isKeysEqual(failure.key, entry.key)) {
        throw new Error(`Missing failure dto for key: ${String(failure.key)}`);
    }
    publishResourceInboxCompletion(dependencies.options, entry);
    recordResourceInboxAttemptRelease(dependencies.options.onAttemptReleaseTelemetry, {
        attempt: original.value,
        released: entry,
        classification: decision.classification,
        failure: toResourceInboxAttemptFailureCause(failure.exception)
    });
    return { key: original.key, value: { ...failure.value, entry }, exception: failure.exception };
}

async function finalizeResourceInboxFailure(
    dependencies: ResourceInboxDequeueDependencies,
    failure: DequeueController.Failure<Resource.Key, ResourceInboxAttempt>
): Promise<ResourceEntry> {
    const exhaustion = toRetryExhaustion({
        failure,
        lane: failure.value.telemetry.selectedLane,
        processingAttempts: dependencies.resilience.retryPolicy.maxAttempts,
        exhaustedAtEpochMs: dependencies.nowEpochMs()
    });
    const finalized = await dependencies.options.onRetryExhausted!(exhaustion);
    dependencies.options.onRetryExhaustionTelemetry?.(exhaustion);
    return finalized;
}

function computeResourceInboxFailureDecision(
    failure: DequeueController.Failure<Resource.Key, ResourceInboxAttempt>,
    policy: ResourceInboxRetryPolicy,
    jitterUnit: number
): ResourceInboxFailureDecision {
    if (isNotReadyException(failure.exception)) {
        return {
            classification: 'not-ready',
            disposition: { status: EntityStatus.RETRY, delayMs: failure.exception.delayMs, reason: 'not-ready' },
            exhausted: false
        };
    }
    if (failure.exception instanceof NonRetryableException || failure.exception instanceof NotReadyException) {
        return {
            classification: 'non-retryable',
            disposition: { status: EntityStatus.NON_RETRYABLE, delayMs: null },
            exhausted: false
        };
    }
    const retry = retryAfterAttempt(policy, failure.value.entry.dequeueAudit.attempts, jitterUnit);
    return {
        classification: 'retryable',
        disposition: retry.status === 'retry'
            ? { status: EntityStatus.RETRY, delayMs: retry.delayMs }
            : { status: EntityStatus.FAILED, delayMs: null },
        exhausted: retry.status === 'failed'
    };
}

function toResourceInboxAttempts(
    dependencies: ResourceInboxDequeueDependencies,
    entries: Map<Resource.Key, ResourceEntry>,
    selectedLane: Reservator
): Map<Resource.Key, ResourceInboxAttempt> {
    const selectedAtEpochMs = dependencies.nowEpochMs();
    return new Map([...entries].map(([key, entry]) => [
        key,
        computeResourceInboxAttempt({
            entry,
            selectedLane,
            selectedAtEpochMs,
            selectedDueAtEpochMs: undefined,
            reservationLeaseMs: dependencies.resilience.reservationLeaseMs
        })
    ]));
}

function recordResourceInboxReservation(event: ResourceInboxFairnessTelemetry): void {
    console.info('ResourceInbox reservation', event);
}

function toHandlerEntryFailure(
    failure: DequeueController.Failure<Resource.Key, ResourceInboxAttempt>
): DequeueController.Failure<Resource.Key, ResourceInboxAttempt> {
    if (!(failure.exception instanceof ResourceInboxHandlerEntryError)) {
        return failure;
    }
    const { entry, handlerError } = failure.exception;
    if (
        !isKeysEqual(entry.key, failure.key) ||
        entry.dequeueAudit.attempts !== failure.value.entry.dequeueAudit.attempts ||
        (entry.status !== EntityStatus.RESERVED && entry.status !== EntityStatus.COMPLETED &&
            entry.status !== EntityStatus.FAILED && entry.status !== EntityStatus.NON_RETRYABLE) ||
        (entry.status === EntityStatus.RESERVED &&
            !hasSameResourceEntryValue(entry, { ...failure.value.entry, resource: entry.resource }))
    ) {
        throw new Error('Handler entry does not identify the claimed reservation');
    }
    return { key: failure.key, value: { ...failure.value, entry }, exception: handlerError };
}

interface RetryExhaustionInput {
    readonly failure: DequeueController.Failure<Resource.Key, ResourceInboxAttempt>;
    readonly lane: Reservator;
    readonly processingAttempts: number;
    readonly exhaustedAtEpochMs: number;
}

function toRetryExhaustion(input: RetryExhaustionInput): ResourceInboxRetryExhaustion {
    const { failure, lane, processingAttempts, exhaustedAtEpochMs } = input;
    const createdAtEpochMs = Number(
        failure.value.entry.audit.createdTs.toZonedDateTime('UTC').epochMilliseconds
    );
    const dueAtEpochMs = failure.value.entry.dequeueAudit.nextTs
        ? Number(failure.value.entry.dequeueAudit.nextTs.epochMilliseconds)
        : Number(failure.value.entry.dequeueAudit.startTs?.epochMilliseconds ?? exhaustedAtEpochMs);
    return {
        entry: failure.value.entry,
        processingAttempts,
        reservationAttempt: failure.value.entry.dequeueAudit.attempts,
        lane,
        classification: 'retryable',
        exhausted: true,
        failure: { source: 'processing', error: failure.exception },
        queueAgeMs: Math.max(0, exhaustedAtEpochMs - createdAtEpochMs),
        dueAgeMs: Math.max(0, exhaustedAtEpochMs - dueAtEpochMs),
        exhaustedAtEpochMs
    };
}

function toRetryExhaustionRecovery(
    attempt: ResourceInboxAttempt,
    processingAttempts: number,
    finalizedAtEpochMs: number
): ResourceInboxRetryExhaustionRecovery {
    const { entry, telemetry } = attempt;
    if (telemetry.selectedLane !== Reservator.FINALIZATION) {
        throw new Error('Finalization recovery selection telemetry is missing');
    }
    return {
        entry,
        processingAttempts,
        reservationAttempt: entry.dequeueAudit.attempts,
        lane: Reservator.FINALIZATION,
        classification: 'retryable',
        exhausted: true,
        failure: { source: 'finalization-recovery' },
        queueAgeMs: telemetry.queueAgeMs,
        dueAgeMs: telemetry.dueAgeMs,
        selectedDueAtEpochMs: telemetry.selectedDueAtEpochMs,
        finalizedAtEpochMs
    };
}

function publishResourceInboxCompletion(options: DequeueResourceEntryOptions, entry: ResourceEntry): void {
    if (RESOURCE_INBOX_COMPLETION_STATUSES.has(entry.status)) {
        options.completionNotifications?.publish(
            entry.key,
            options.toCompletionAwaitability?.(entry) ?? 'awaitable'
        );
    }
}

function isHandlerFinalized(computedValue: unknown): computedValue is ResourceInboxHandlerFinalized {
    return computedValue instanceof ResourceInboxHandlerFinalizedSuccess ||
        computedValue instanceof ResourceInboxHandlerFinalizedRejection;
}

function toHandlerFinalizedResourceInboxRelease<V>(
    original: DequeueController.Success<Resource.Key, ResourceInboxAttempt, V>,
    finalized: ResourceInboxHandlerFinalized
): ResourceInboxReleasedSuccess<V> {
    const { entry } = finalized;
    const expectedStatuses: readonly EntityStatus[] = finalized instanceof ResourceInboxHandlerFinalizedSuccess
        ? [EntityStatus.COMPLETED]
        : [EntityStatus.FAILED, EntityStatus.NON_RETRYABLE];
    if (
        !isKeysEqual(entry.key, original.key) ||
        entry.dequeueAudit.attempts !== original.value.entry.dequeueAudit.attempts ||
        !expectedStatuses.includes(entry.status)
    ) {
        throw new Error('Handler-finalized entry does not finalize the claimed reservation');
    }
    if (finalized instanceof ResourceInboxHandlerFinalizedSuccess) {
        return { original, entry, classification: 'accepted', failure: undefined };
    }
    console.error(
        `Handler rejected dequeued key ${toDequeuedKeyText(original.key)} as ${finalized.code}.`,
        toErrorSummary(finalized.cause)
    );
    return {
        original,
        entry,
        classification: 'non-retryable',
        failure: { code: finalized.code, name: finalized.cause.name }
    };
}

function toReleasedResourceInboxSuccess<V>(
    key: Resource.Key,
    entry: ResourceEntry,
    successes: Map<Resource.Key, DequeueController.Success<Resource.Key, ResourceInboxAttempt, V>>
): ResourceInboxReleasedSuccess<V> {
    const original = [...successes.values()].find((success) => isKeysEqual(success.key, key));
    if (original === undefined || !isKeysEqual(entry.key, key)) {
        throw new Error(`Missing success dto for key: ${String(key)}`);
    }
    return { original, entry, classification: 'accepted', failure: undefined };
}
