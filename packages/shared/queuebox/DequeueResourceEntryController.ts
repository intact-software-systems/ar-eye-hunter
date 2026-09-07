import { Temporal } from '@js-temporal/polyfill';
import { CircuitBreaker, CircuitBreakerPolicy } from '../resilience/circuit-breaker.ts';
import { Either, EitherCollectors } from '../resilience/Either.ts';
import { RateAdjuster, RateAdjusterPolicy, RateLimiter } from '../resilience/Resilience.ts';
import { DequeueController, FailureDto, Reservator, SuccessDto } from './DequeueController.ts';
import { hasSameResourceEntryValue } from './has-same-resource-entry-value.ts';
import {
    DequeueResourceEntryRepository,
    toSaturatedResourceInboxFairnessScanBudget,
    type ResourceInboxFinalizationSelection,
    type ResourceInboxReleaseDisposition,
    type ResourceInboxWorkAdvertisementOptions
} from './queue-box-types.ts';
import * as Resource from './ResourceEntry.ts';
import { EntityStatus, isKeysEqual, ResourceEntry } from './ResourceEntry.ts';
import {
    computeResourceInboxAttempt,
    recordResourceInboxAttemptRelease,
    type ResourceInboxAttempt,
    type ResourceInboxAttemptReleaseTelemetry
} from './ResourceInboxAttemptTelemetry.ts';
import {
    DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
    ResourceInboxFairnessTelemetry,
    ResourceInboxRetryPolicy,
    retryAfterAttempt,
    toResourceInboxFairnessTelemetry
} from './ResourceInboxRetryPolicy.ts';

// -----------------------------------------
// Minimal domain contracts (adjust/import)
// -----------------------------------------

export class NonRetryableException extends Error {
    constructor(message?: string) {
        super(message);
        this.name = 'NonRetryableException';
    }
}

export type ResourceInboxRetryClassification = 'retryable' | 'non-retryable';

export type ResourceInboxRetryExhaustion = Readonly<{
    entry: ResourceEntry;
    processingAttempts: number;
    reservationAttempt: number;
    lane: Reservator;
    classification: 'retryable';
    exhausted: true;
    failure: Readonly<{ source: 'processing'; error: Error; }>;
    queueAgeMs: number;
    dueAgeMs: number;
    exhaustedAtEpochMs: number;
}>;

export type ResourceInboxRetryExhaustionRecovery = Readonly<{
    entry: ResourceEntry;
    processingAttempts: number;
    reservationAttempt: number;
    lane: typeof Reservator.FINALIZATION;
    classification: 'retryable';
    exhausted: true;
    failure: Readonly<{ source: 'finalization-recovery'; }>;
    queueAgeMs: number;
    dueAgeMs: number;
    selectedDueAtEpochMs: number;
    finalizedAtEpochMs: number;
}>;

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

// -----------------------------------------
// class ResilienceDto
// -----------------------------------------

export class ResilienceDto {
    static readonly MAX_NUM_IS_ENTRY_CHECK = 1;
    static readonly MAX_NUM_DEQUEUE_IN_WINDOW = 10;

    // Duration.ofMinutes(1), Duration.ofHours(1)
    static readonly RATE_LIMITER_RESERVED_TIMEOUT_SLIDING_WINDOW_DURATION_MS = 1 * 60 * 1000;
    static readonly RATE_LIMITER_FAIRNESS_CHECK_SLIDING_WINDOW_DURATION_MS = 60 * 1000;

    static readonly MIN_CONSECUTIVE_SUCCESSES = 10;
    // Duration.ofMinutes(15)
    static readonly RATE_ADJUST_WINDOW_MS = 15 * 60 * 1000;

    public readonly circuitBreaker: CircuitBreaker;
    public readonly checkReserveTimeouts: InstanceType<typeof ResilienceDto.StatusChecker>;
    public readonly checkFairness: InstanceType<typeof ResilienceDto.StatusChecker>;
    public readonly checkFinalization: InstanceType<typeof ResilienceDto.StatusChecker>;
    public readonly rateAdjuster: RateAdjuster;
    public readonly retryPolicy: ResourceInboxRetryPolicy;

    constructor(
        circuitBreaker: CircuitBreaker,
        checkReserveTimeouts: InstanceType<typeof ResilienceDto.StatusChecker>,
        checkFairness: InstanceType<typeof ResilienceDto.StatusChecker>,
        checkFinalization: InstanceType<typeof ResilienceDto.StatusChecker>,
        rateAdjuster: RateAdjuster,
        retryPolicy: ResourceInboxRetryPolicy = DEFAULT_RESOURCE_INBOX_RETRY_POLICY
    ) {
        this.circuitBreaker = circuitBreaker;
        this.checkReserveTimeouts = checkReserveTimeouts;
        this.checkFairness = checkFairness;
        this.checkFinalization = checkFinalization;
        this.rateAdjuster = rateAdjuster;
        this.retryPolicy = retryPolicy;
    }

    toWorkAdvertisementOptions(): ResourceInboxWorkAdvertisementOptions {
        return {
            checkTimeout: this.checkReserveTimeouts.isEntryRateLimiter,
            checkFairness: this.checkFairness.isEntryRateLimiter,
            checkFinalization: this.checkFinalization.isEntryRateLimiter,
            maxAttempts: this.retryPolicy.maxAttempts,
            finalizationStaleAfterMs: DequeueResourceEntryController.FINALIZATION_STALE_AFTER_MS
        };
    }

    success(): void {
        this.circuitBreaker.success();
        this.rateAdjuster.success();
    }

    failure(): void {
        this.circuitBreaker.failure();
        this.rateAdjuster.failure();
    }

    toMaxNumToReserve(defaultMaxNumToReserve: number): number {
        return this.circuitBreaker.allow() ? defaultMaxNumToReserve : 0;
    }

    isNotAllowedThroughToDequeue(): boolean {
        return !this.circuitBreaker.isAllowedThrough();
    }

    // -------------------------
    // Java record StatusChecker
    // -------------------------
    static StatusChecker = class StatusChecker {
        public readonly isEntryRateLimiter: RateLimiter;
        public readonly lockEntryRateLimiter: RateLimiter;

        constructor(
            isEntryRateLimiter: RateLimiter,
            lockEntryRateLimiter: RateLimiter
        ) {
            this.isEntryRateLimiter = isEntryRateLimiter;
            this.lockEntryRateLimiter = lockEntryRateLimiter;
        }

        static toReserveEntryTimeoutChecker(): InstanceType<typeof ResilienceDto.StatusChecker> {
            return new ResilienceDto.StatusChecker(
                RateLimiter.init(
                    ResilienceDto.RATE_LIMITER_RESERVED_TIMEOUT_SLIDING_WINDOW_DURATION_MS,
                    ResilienceDto.MAX_NUM_IS_ENTRY_CHECK
                ),
                RateLimiter.init(
                    ResilienceDto.RATE_LIMITER_RESERVED_TIMEOUT_SLIDING_WINDOW_DURATION_MS,
                    ResilienceDto.MAX_NUM_DEQUEUE_IN_WINDOW
                )
            );
        }

        static toFairnessEntryChecker(
            maxSelectionsInWindow: number = ResilienceDto.MAX_NUM_DEQUEUE_IN_WINDOW
        ): InstanceType<typeof ResilienceDto.StatusChecker> {
            return new ResilienceDto.StatusChecker(
                RateLimiter.init(
                    ResilienceDto.RATE_LIMITER_FAIRNESS_CHECK_SLIDING_WINDOW_DURATION_MS,
                    ResilienceDto.MAX_NUM_IS_ENTRY_CHECK
                ),
                RateLimiter.init(
                    ResilienceDto.RATE_LIMITER_FAIRNESS_CHECK_SLIDING_WINDOW_DURATION_MS,
                    maxSelectionsInWindow
                )
            );
        }
    };

    static toResilienceDto(
        circuitBreakerPolicy: CircuitBreakerPolicy,
        initialRate: number,
        maxRate: number,
        concurrencyIncreaseStep: number,
        concurrencyReduceStep: number,
        maxFairnessSelectionsInWindow: number = ResilienceDto.MAX_NUM_DEQUEUE_IN_WINDOW,
        retryPolicy: ResourceInboxRetryPolicy = DEFAULT_RESOURCE_INBOX_RETRY_POLICY
    ): ResilienceDto {
        const policy = RateAdjuster.toPolicy(
            initialRate,
            maxRate,
            concurrencyIncreaseStep,
            concurrencyReduceStep,
            ResilienceDto.MIN_CONSECUTIVE_SUCCESSES,
            ResilienceDto.RATE_ADJUST_WINDOW_MS
        );

        return new ResilienceDto(
            CircuitBreaker.create(circuitBreakerPolicy),
            ResilienceDto.StatusChecker.toReserveEntryTimeoutChecker(),
            ResilienceDto.StatusChecker.toFairnessEntryChecker(maxFairnessSelectionsInWindow),
            ResilienceDto.StatusChecker.toReserveEntryTimeoutChecker(),
            RateAdjuster.create(
                new RateAdjusterPolicy(
                    policy.initialRate,
                    policy.maxRate,
                    policy.concurrencyIncreaseStep,
                    policy.concurrencyReduceStep,
                    policy.minConsecutiveSuccesses,
                    policy.adjustWindowMs
                )
            ),
            retryPolicy
        );
    }
}

// -----------------------------------------
// Converted DequeueResourceEntry
// -----------------------------------------

export class DequeueResourceEntryController {
    static readonly TIMEOUT_ON_NON_RESPONSIVE_ENTRY_MS = Temporal.Duration.from({ milliseconds: 5 * 60 * 1000 });
    static readonly FINALIZATION_STALE_AFTER_MS = 5 * 60 * 1000;

    // -------------------------
    // Java record ResilienceDto
    // -------------------------
    public static toDequeuer<V>(
        dequeueResourceEntryRepository: DequeueResourceEntryRepository,
        typesToDequeue: () => Set<string>,
        maxToReserve: () => number,
        maxRetries: number,
        maxNumToDequeue: number,
        resilience: ResilienceDto,
        options: DequeueResourceEntryOptions = {}
    ): DequeueController<Resource.Key, ResourceInboxAttempt, V> {
        const retryPolicy = resilience.retryPolicy;
        if (
            options.retryPolicy &&
            !isResourceInboxRetryPolicyEqual(options.retryPolicy, retryPolicy)
        ) {
            throw new Error('Dequeue retry policy override must match resilience retry policy');
        }
        if (maxRetries !== retryPolicy.maxAttempts) {
            throw new Error(
                `ResourceInbox retry limit ${maxRetries} must match policy maxAttempts ${retryPolicy.maxAttempts}`
            );
        }

        const nowEpochMs = options.nowEpochMs ?? Date.now;
        const jitterUnit = options.jitterUnit ?? Math.random;
        const recordReservationTelemetry = options.onReservationTelemetry ??
            ((event: ResourceInboxFairnessTelemetry) => {
                console.info('ResourceInbox reservation', event);
            });
        const toAttempts = (
            entries: Map<Resource.Key, ResourceEntry>,
            selectedLane: Reservator
        ): Map<Resource.Key, ResourceInboxAttempt> => {
            const selectedAtEpochMs = nowEpochMs();
            return new Map([...entries].map(([key, entry]) => [
                key,
                computeResourceInboxAttempt({
                    entry,
                    selectedLane,
                    selectedAtEpochMs,
                    selectedDueAtEpochMs: undefined
                })
            ]));
        };

        return DequeueController
            .create<Resource.Key, ResourceInboxAttempt, V>()
            .withInboxTypesToDequeue(typesToDequeue)
            .withMaxNumToDequeue(maxNumToDequeue)
            .withMaxNumToReserve(maxToReserve)
            .onFinalizationEntriesReserveDo(
                options.onRetryExhaustionRecovery
                    ? async (types, maxNumToReserve) => {
                        const selectedAtEpochMs = nowEpochMs();
                        const selections = await RateLimiter.tryToExecuteOrDefault(
                            resilience.checkFinalization.lockEntryRateLimiter,
                            () =>
                                dequeueResourceEntryRepository.reserveRetryExhaustionFinalizations(
                                    types,
                                    {
                                        processingAttempts: retryPolicy.maxAttempts,
                                        maxToReserve: maxNumToReserve,
                                        staleAfterMs: DequeueResourceEntryController.FINALIZATION_STALE_AFTER_MS
                                    }
                                ),
                            new Map<Resource.Key, ResourceInboxFinalizationSelection>()
                        );
                        const entries = new Map<Resource.Key, ResourceInboxAttempt>();
                        for (const [key, selection] of selections) {
                            entries.set(
                                key,
                                computeResourceInboxAttempt({
                                    entry: selection.entry,
                                    selectedLane: Reservator.FINALIZATION,
                                    selectedAtEpochMs,
                                    selectedDueAtEpochMs: Number(selection.selectedDueTs.epochMilliseconds)
                                })
                            );
                        }
                        return entries;
                    }
                    : undefined
            )
            .onFinalizationEntriesDo(
                options.onRetryExhaustionRecovery
                    ? async (key, entry) => {
                        const finalizedAtEpochMs = nowEpochMs();
                        const recovery = toRetryExhaustionRecovery(
                            entry,
                            retryPolicy.maxAttempts,
                            finalizedAtEpochMs
                        );
                        await options.onRetryExhaustionRecovery!(recovery);
                        options.onRetryExhaustionTelemetry?.(recovery);
                        return key as V;
                    }
                    : undefined
            )
            .onNewEntriesReserveDo(async (types, maxNumToReserve) =>
                toAttempts(
                    await dequeueResourceEntryRepository.reserveEntries(
                        types,
                        new Set([EntityStatus.NEW]),
                        {
                            maxToReserve: maxNumToReserve,
                            maxAttempts: retryPolicy.maxAttempts
                        }
                    ),
                    Reservator.NEW
                )
            )
            .onRetryEntriesReserveDo(async (types, maxNumToReserve) =>
                toAttempts(
                    await dequeueResourceEntryRepository.reserveEntries(
                        types,
                        new Set([EntityStatus.RETRY]),
                        {
                            maxToReserve: maxNumToReserve,
                            maxAttempts: retryPolicy.maxAttempts
                        }
                    ),
                    Reservator.RETRY
                )
            )
            .onFairnessEntriesReserveDo(async (types, maxNumToReserve) =>
                await RateLimiter.tryToExecuteOrDefault(
                    resilience.checkFairness.lockEntryRateLimiter,
                    async () => {
                        const selectedAtEpochMs = nowEpochMs();
                        const reserved = await dequeueResourceEntryRepository.reserveOverdueRetryEntries(
                            types,
                            selectedAtEpochMs - retryPolicy.staleDueThresholdMs,
                            {
                                maxToReserve: maxNumToReserve,
                                maxAttempts: retryPolicy.maxAttempts,
                                maxToScan: Math.max(
                                    types.size,
                                    toSaturatedResourceInboxFairnessScanBudget(maxNumToReserve)
                                )
                            }
                        );
                        for (const selection of reserved.values()) {
                            recordReservationTelemetry(
                                toResourceInboxFairnessTelemetry(
                                    selection,
                                    selectedAtEpochMs
                                )
                            );
                        }
                        return new Map(
                            [...reserved].map(([key, selection]) => [
                                key,
                                computeResourceInboxAttempt({
                                    entry: selection.entry,
                                    selectedLane: Reservator.FAIRNESS,
                                    selectedAtEpochMs,
                                    selectedDueAtEpochMs: Number(selection.selectedDueTs.epochMilliseconds)
                                })
                            ])
                        );
                    },
                    new Map<Resource.Key, ResourceInboxAttempt>()
                )
            )
            .onTimeoutEntriesReserveDo(async (types, maxNumToReserve) => {
                const reservedTimeoutEntries = await RateLimiter.tryToExecuteOrDefault(
                    resilience.checkReserveTimeouts.lockEntryRateLimiter,
                    () =>
                        dequeueResourceEntryRepository.reserveTimeoutEntries(
                            types,
                            {
                                maxToReserve: maxNumToReserve,
                                maxAttempts: retryPolicy.maxAttempts
                            },
                            DequeueResourceEntryController.TIMEOUT_ON_NON_RESPONSIVE_ENTRY_MS
                        ),
                    new Map<Resource.Key, ResourceEntry>()
                );

                if (reservedTimeoutEntries.size > 0) {
                    console.info(
                        `${
                            Array.from(types).join(',')
                        } Reserved entries that DNF before TIMEOUT ${DequeueResourceEntryController.TIMEOUT_ON_NON_RESPONSIVE_ENTRY_MS}ms, entries: ${
                            Array.from(reservedTimeoutEntries.keys()).join(',')
                        }`
                    );
                }

                return toAttempts(reservedTimeoutEntries, Reservator.TIMEOUT);
            })
            .onReleaseEntriesDo(
                // successReleaser
                async (successByKey) => {
                    const released = await dequeueResourceEntryRepository.releaseEntries(
                        Array.from(successByKey.values())
                            .map((dto) => dto.value.entry),
                        { status: EntityStatus.COMPLETED, delayMs: null }
                    );

                    const out = new Map<Resource.Key, SuccessDto<Resource.Key, ResourceInboxAttempt, V>>();

                    for (const [k, v] of released.entries()) {
                        const original = Array.from(successByKey.values())
                            .find((dto) => isKeysEqual(dto.key, k));

                        if (!original) {
                            throw new Error(`Missing success dto for key: ${String(k)}`);
                        }

                        recordResourceInboxAttemptRelease(
                            options.onAttemptReleaseTelemetry,
                            { attempt: original.value, released: v, classification: 'accepted', exception: undefined }
                        );
                        out.set(k, new SuccessDto(k, { ...original.value, entry: v }, original.computedValue));
                    }
                    return out;
                },
                // failureReleaser
                async (failureByKey) => {
                    const out = new Map<Resource.Key, FailureDto<Resource.Key, ResourceInboxAttempt>>();
                    for (const original of failureByKey.values()) {
                        const failure = toHandlerEntryFailure(original);
                        if (
                            original.exception instanceof ResourceInboxHandlerEntryError &&
                            failure.value.entry.status !== EntityStatus.RESERVED
                        ) {
                            recordResourceInboxAttemptRelease(
                                options.onAttemptReleaseTelemetry,
                                {
                                    attempt: original.value,
                                    released: failure.value.entry,
                                    classification: failure.value.entry.status === EntityStatus.COMPLETED
                                        ? 'accepted'
                                        : 'non-retryable',
                                    exception: failure.exception
                                }
                            );
                            out.set(failure.key, failure);
                            continue;
                        }
                        const nonRetryable = DequeueResourceEntryController.isNonRetryableException(failure);
                        const decision = nonRetryable
                            ? { status: 'failed' as const, delayMs: null }
                            : retryAfterAttempt(
                                retryPolicy,
                                failure.value.entry.dequeueAudit.attempts,
                                jitterUnit()
                            );
                        let disposition: ResourceInboxReleaseDisposition;
                        if (nonRetryable) {
                            disposition = {
                                status: EntityStatus.NON_RETRYABLE,
                                delayMs: null
                            };
                        }
                        else if (decision.status === 'retry') {
                            if (decision.delayMs === null) {
                                throw new Error('Retry decision is missing a release delay');
                            }
                            disposition = {
                                status: EntityStatus.RETRY,
                                delayMs: decision.delayMs
                            };
                        }
                        else if (options.onRetryExhausted) {
                            const exhaustedAtEpochMs = nowEpochMs();
                            const exhaustion = toRetryExhaustion({
                                failure,
                                lane: original.value.telemetry.selectedLane,
                                processingAttempts: retryPolicy.maxAttempts,
                                exhaustedAtEpochMs
                            });
                            const finalized = await options.onRetryExhausted(exhaustion);
                            options.onRetryExhaustionTelemetry?.(exhaustion);
                            recordResourceInboxAttemptRelease(
                                options.onAttemptReleaseTelemetry,
                                {
                                    attempt: original.value,
                                    released: finalized,
                                    classification: 'retryable',
                                    exception: failure.exception
                                }
                            );
                            out.set(
                                failure.key,
                                new FailureDto(
                                    failure.key,
                                    { ...failure.value, entry: finalized },
                                    failure.exception
                                )
                            );
                            continue;
                        }
                        else {
                            disposition = {
                                status: EntityStatus.FAILED,
                                delayMs: null
                            };
                        }
                        const released = await dequeueResourceEntryRepository.releaseEntries(
                            [failure.value.entry],
                            disposition
                        );
                        for (const [k, v] of released.entries()) {
                            if (!isKeysEqual(failure.key, k)) {
                                throw new Error(`Missing failure dto for key: ${String(k)}`);
                            }

                            recordResourceInboxAttemptRelease(
                                options.onAttemptReleaseTelemetry,
                                {
                                    attempt: original.value,
                                    released: v,
                                    classification: nonRetryable ? 'non-retryable' : 'retryable',
                                    exception: failure.exception
                                }
                            );
                            out.set(k, new FailureDto(k, { ...failure.value, entry: v }, failure.exception));
                        }
                    }

                    return out;
                }
            );
    }

    private static isNonRetryableException(
        failure: FailureDto<Resource.Key, ResourceInboxAttempt>
    ): boolean {
        return failure.exception instanceof NonRetryableException;
    }

    // -------------------------
    // Utility conversions
    // -------------------------

    static toFailures<K, V, T>(
        dequeued: Map<Reservator, Map<K, Either<FailureDto<K, V>, SuccessDto<K, V, T>>>>
    ): Array<FailureDto<K, V>> {
        const out: Array<FailureDto<K, V>> = [];
        for (const entry of dequeued.values()) {
            for (const failure of EitherCollectors.toMapFoldLefts(entry).values()) {
                out.push(failure);
            }
        }
        return out;
    }

    static toSuccesses<K, V, T>(
        dequeued: Map<Reservator, Map<K, Either<FailureDto<K, V>, SuccessDto<K, V, T>>>>
    ): Array<SuccessDto<K, V, T>> {
        const out: Array<SuccessDto<K, V, T>> = [];
        for (const entry of dequeued.values()) {
            for (const success of EitherCollectors.toMapFoldRights(entry).values()) {
                out.push(success);
            }
        }
        return out;
    }

    static toResultsByKey<K, V, T>(
        dequeued: Map<Reservator, Map<K, Either<FailureDto<K, V>, SuccessDto<K, V, T>>>>
    ): Map<K, Either<Error, T>> {
        const out = new Map<K, Either<Error, T>>();

        for (const entry of dequeued.values()) {
            for (const either of entry.values()) {
                const kv = either.fold(
                    (failure) =>
                        [
                            failure.key,
                            Either.ofLeft<Error, T>(failure.exception)
                        ] as const,
                    (success) => [success.key, Either.ofRight<Error, T>(success.computedValue)] as const
                );
                out.set(kv[0], kv[1]);
            }
        }

        return out;
    }
}

export type DequeueResourceEntryOptions = Readonly<{
    retryPolicy?: ResourceInboxRetryPolicy;
    jitterUnit?: () => number;
    nowEpochMs?: () => number;
    onReservationTelemetry?: (event: ResourceInboxFairnessTelemetry) => void;
    onAttemptReleaseTelemetry?: (event: ResourceInboxAttemptReleaseTelemetry) => void;
    onRetryExhausted?: (
        exhaustion: ResourceInboxRetryExhaustion
    ) => Promise<ResourceEntry>;
    onRetryExhaustionTelemetry?: (
        exhaustion: ResourceInboxRetryExhaustion | ResourceInboxRetryExhaustionRecovery
    ) => void;
    onRetryExhaustionRecovery?: (
        exhaustion: ResourceInboxRetryExhaustionRecovery
    ) => Promise<ResourceEntry>;
}>;

function toHandlerEntryFailure(
    failure: FailureDto<Resource.Key, ResourceInboxAttempt>
): FailureDto<Resource.Key, ResourceInboxAttempt> {
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
    return new FailureDto(failure.key, { ...failure.value, entry }, handlerError);
}

interface RetryExhaustionInput {
    readonly failure: FailureDto<Resource.Key, ResourceInboxAttempt>;
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

function isResourceInboxRetryPolicyEqual(
    left: ResourceInboxRetryPolicy,
    right: ResourceInboxRetryPolicy
): boolean {
    return left.maxAttempts === right.maxAttempts &&
        left.maxDelayMs === right.maxDelayMs &&
        left.jitterRatio === right.jitterRatio &&
        left.staleDueThresholdMs === right.staleDueThresholdMs &&
        left.delaysAfterAttemptMs.length === right.delaysAfterAttemptMs.length &&
        left.delaysAfterAttemptMs.every(
            (delayMs, index) => delayMs === right.delaysAfterAttemptMs[index]
        );
}
