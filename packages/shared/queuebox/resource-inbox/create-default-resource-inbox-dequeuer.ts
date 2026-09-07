import { Temporal } from '@js-temporal/polyfill';

import { RateLimiter } from '../../resilience/Resilience.ts';
import { DequeueController, Reservator } from '../dequeue/dequeue-controller.ts';
import {
    DequeueResourceEntryRepository,
    toSaturatedResourceInboxFairnessScanBudget,
    type ResourceInboxFinalizationSelection,
    type ResourceInboxReleaseDisposition
} from '../queue-box-types.ts';
import { hasSameResourceEntryValue } from '../resource-entry-observations.ts';
import * as Resource from '../ResourceEntry.ts';
import {
    EntityStatus,
    isKeysEqual,
    ResourceEntry
} from '../ResourceEntry.ts';
import {
    ResourceInboxFairnessTelemetry,
    ResourceInboxRetryPolicy,
    retryAfterAttempt,
    toResourceInboxFairnessTelemetry
} from '../ResourceInboxRetryPolicy.ts';
import { isNotReadyException, NotReadyException } from './not-ready-exception.ts';
import {
    computeResourceInboxAttempt,
    recordResourceInboxAttemptRelease,
    type ResourceInboxAttempt,
    type ResourceInboxAttemptReleaseTelemetry
} from './resource-inbox-attempt-telemetry.ts';
import { ResourceInboxResilience } from './resource-inbox-resilience.ts';

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

export interface ResourceInboxDequeuerInput {
    readonly repository: DequeueResourceEntryRepository;
    readonly typesToDequeue: () => Set<string>;
    readonly maxToReserve: () => number;
    readonly maxNumToDequeue: number;
    readonly resilience: ResourceInboxResilience;
    readonly options?: DequeueResourceEntryOptions;
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
    return DequeueController.create<Resource.Key, ResourceInboxAttempt, V>()
        .withInboxTypesToDequeue(input.typesToDequeue)
        .withMaxNumToDequeue(input.maxNumToDequeue)
        .withMaxNumToReserve(input.maxToReserve)
        .onFinalizationEntriesReserveDo(
            options.onRetryExhaustionRecovery
                ? (types, maxToReserve) => reserveResourceInboxFinalizations(dependencies, types, maxToReserve)
                : undefined
        )
        .onFinalizationEntriesDo(
            options.onRetryExhaustionRecovery
                ? async (key, attempt) => {
                    await finalizeResourceInboxRecovery(dependencies, attempt);
                    return key as V;
                }
                : undefined
        )
        .onNewEntriesReserveDo((types, maxToReserve) =>
            reserveResourceInboxAttempts(dependencies, { types, maxToReserve, lane: Reservator.NEW })
        )
        .onRetryEntriesReserveDo((types, maxToReserve) =>
            reserveResourceInboxAttempts(dependencies, { types, maxToReserve, lane: Reservator.RETRY })
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
        }
    });
    return toResourceInboxAttempts(entries, selection.lane, dependencies.nowEpochMs());
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
                    milliseconds: ResourceInboxResilience.FINALIZATION_STALE_AFTER_MS
                })
            }),
        new Map<Resource.Key, ResourceEntry>()
    );
    if (entries.size > 0) {
        console.info('Reserved timed-out resource inbox entries', [...entries.keys()]);
    }
    return toResourceInboxAttempts(entries, Reservator.TIMEOUT, dependencies.nowEpochMs());
}

async function reserveResourceInboxFairness(
    dependencies: ResourceInboxDequeueDependencies,
    types: Set<string>,
    maxToReserve: number
): Promise<Map<Resource.Key, ResourceInboxAttempt>> {
    return await RateLimiter.tryToExecuteOrDefault(
        dependencies.resilience.checkFairness.lockEntryRateLimiter,
        () => readResourceInboxFairness(dependencies, types, maxToReserve),
        new Map<Resource.Key, ResourceInboxAttempt>()
    );
}

async function readResourceInboxFairness(
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
                selectedDueAtEpochMs: Number(selection.selectedDueTs.epochMilliseconds)
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
            selectedDueAtEpochMs: Number(selection.selectedDueTs.epochMilliseconds)
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
    await dependencies.options.onRetryExhaustionRecovery!(recovery);
    dependencies.options.onRetryExhaustionTelemetry?.(recovery);
}

async function releaseResourceInboxSuccesses<V>(
    dependencies: ResourceInboxDequeueDependencies,
    successes: Map<Resource.Key, DequeueController.Success<Resource.Key, ResourceInboxAttempt, V>>
): Promise<Map<Resource.Key, DequeueController.Success<Resource.Key, ResourceInboxAttempt, V>>> {
    const released = await dependencies.repository.releaseEntries(
        [...successes.values()].map((success) => success.value.entry),
        {
            status: EntityStatus.COMPLETED,
            delayMs: null
        }
    );
    const result = new Map<Resource.Key, DequeueController.Success<Resource.Key, ResourceInboxAttempt, V>>();
    for (const [key, entry] of released) {
        const original = [...successes.values()].find((success) => isKeysEqual(success.key, key));
        if (original === undefined) {
            throw new Error(`Missing success dto for key: ${String(key)}`);
        }
        recordResourceInboxAttemptRelease(dependencies.options.onAttemptReleaseTelemetry, {
            attempt: original.value,
            released: entry,
            classification: 'accepted',
            exception: undefined
        });
        result.set(original.key, {
            key: original.key,
            value: { ...original.value, entry },
            computedValue: original.computedValue
        });
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
            exception: failure.exception
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
        : [...(await dependencies.repository.releaseEntries([failure.value.entry], decision.disposition)).values()][0];
    if (entry === undefined) {
        return undefined;
    }
    if (!isKeysEqual(failure.key, entry.key)) {
        throw new Error(`Missing failure dto for key: ${String(failure.key)}`);
    }
    recordResourceInboxAttemptRelease(dependencies.options.onAttemptReleaseTelemetry, {
        attempt: original.value,
        released: entry,
        classification: decision.classification,
        exception: failure.exception
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
    entries: Map<Resource.Key, ResourceEntry>,
    selectedLane: Reservator,
    selectedAtEpochMs: number
): Map<Resource.Key, ResourceInboxAttempt> {
    return new Map([...entries].map(([key, entry]) => [
        key,
        computeResourceInboxAttempt({
            entry,
            selectedLane,
            selectedAtEpochMs,
            selectedDueAtEpochMs: undefined
        })
    ]));
}

function recordResourceInboxReservation(event: ResourceInboxFairnessTelemetry): void {
    console.info('ResourceInbox reservation', event);
}
export interface DequeueResourceEntryOptions {
    readonly jitterUnit?: () => number;
    readonly nowEpochMs?: () => number;
    readonly onReservationTelemetry?: (event: ResourceInboxFairnessTelemetry) => void;
    readonly onAttemptReleaseTelemetry?: (event: ResourceInboxAttemptReleaseTelemetry) => void;
    readonly onRetryExhausted?: (
        exhaustion: ResourceInboxRetryExhaustion
    ) => Promise<ResourceEntry>;
    readonly onRetryExhaustionTelemetry?: (
        exhaustion: ResourceInboxRetryExhaustion | ResourceInboxRetryExhaustionRecovery
    ) => void;
    readonly onRetryExhaustionRecovery?: (
        exhaustion: ResourceInboxRetryExhaustionRecovery
    ) => Promise<ResourceEntry>;
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
