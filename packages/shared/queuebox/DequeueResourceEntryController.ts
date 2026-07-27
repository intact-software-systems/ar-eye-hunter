import { Temporal } from '@js-temporal/polyfill';
import { Either, EitherCollectors } from '../resilience/Either.ts';
import {
    CircuitBreaker,
    CircuitBreakerPolicy,
    RateAdjuster,
    RateAdjusterPolicy,
    RateLimiter
} from '../resilience/Resilience.ts';
import { DequeueController, FailureDto, Reservator, SuccessDto } from './DequeueController.ts';
import {
    DequeueResourceEntryRepository,
    type ResourceInboxReleaseDisposition,
    type ResourceInboxFinalizationSelection,
    type ResourceInboxWorkAdvertisementOptions,
    toSaturatedResourceInboxFairnessScanBudget,
} from './QueueBoxTypes.ts';
import * as Resource from './ResourceEntry.ts';
import { EntityStatus, isKeysEqual, ResourceEntry } from './ResourceEntry.ts';
import {
    DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
    ResourceInboxFairnessTelemetry,
    ResourceInboxRetryPolicy,
    retryAfterAttempt,
    toResourceInboxFairnessTelemetry,
} from './ResourceInboxRetryPolicy.ts';
import {
    readResourceInboxAttemptTelemetry,
    recordResourceInboxAttemptRelease,
    rememberResourceInboxAttemptTelemetry,
    type ResourceInboxAttemptReleaseTelemetry,
} from './ResourceInboxAttemptTelemetry.ts';
export { readResourceInboxAttemptTelemetry } from './ResourceInboxAttemptTelemetry.ts';

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
    failure: Readonly<{ source: 'processing'; error: Error }>;
    queueAgeMs: number;
    dueAgeMs: number;
    exhaustedAtEpochMs: number;
}>;

export type ResourceInboxRetryExhaustionRecovery = Readonly<{
    entry: ResourceEntry;
    processingAttempts: number;
    reservationAttempt: number;
    lane: Reservator.FINALIZATION;
    classification: 'retryable';
    exhausted: true;
    failure: Readonly<{ source: 'finalization-recovery' }>;
    queueAgeMs: number;
    dueAgeMs: number;
    selectedDueAtEpochMs: number;
    finalizedAtEpochMs: number;
}>;

export class ResourceInboxFinalizedByHandlerError extends Error {
    readonly code = 'resource-inbox-finalized-by-handler';

    constructor(
        readonly entry: ResourceEntry,
        readonly handlerError: Error,
    ) {
        super('Resource inbox entry was finalized by its handler', {
            cause: handlerError,
        });
        this.name = 'ResourceInboxFinalizedByHandlerError';
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

    constructor(
        public readonly circuitBreaker: CircuitBreaker,
        public readonly checkReserveTimeouts: InstanceType<typeof ResilienceDto.StatusChecker>,
        public readonly checkFairness: InstanceType<typeof ResilienceDto.StatusChecker>,
        public readonly checkFinalization: InstanceType<typeof ResilienceDto.StatusChecker>,
        public readonly rateAdjuster: RateAdjuster,
        public readonly retryPolicy: ResourceInboxRetryPolicy = DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
    ) {
    }

    toWorkAdvertisementOptions(): ResourceInboxWorkAdvertisementOptions {
        return {
            checkTimeout: this.checkReserveTimeouts.isEntryRateLimiter,
            checkFairness: this.checkFairness.isEntryRateLimiter,
            checkFinalization: this.checkFinalization.isEntryRateLimiter,
            maxAttempts: this.retryPolicy.maxAttempts,
            finalizationStaleAfterMs: DequeueResourceEntryController.FINALIZATION_STALE_AFTER_MS,
        };
    }

    get checkFailed(): InstanceType<typeof ResilienceDto.StatusChecker> {
        return this.checkFairness;
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
        constructor(
            public readonly isEntryRateLimiter: RateLimiter,
            public readonly lockEntryRateLimiter: RateLimiter,
        ) {
        }

        static toReserveEntryTimeoutChecker(): InstanceType<typeof ResilienceDto.StatusChecker> {
            return new ResilienceDto.StatusChecker(
                RateLimiter.init(
                    ResilienceDto.RATE_LIMITER_RESERVED_TIMEOUT_SLIDING_WINDOW_DURATION_MS,
                    ResilienceDto.MAX_NUM_IS_ENTRY_CHECK,
                ),
                RateLimiter.init(
                    ResilienceDto.RATE_LIMITER_RESERVED_TIMEOUT_SLIDING_WINDOW_DURATION_MS,
                    ResilienceDto.MAX_NUM_DEQUEUE_IN_WINDOW,
                ),
            );
        }

        static toFairnessEntryChecker(
            maxSelectionsInWindow: number = ResilienceDto.MAX_NUM_DEQUEUE_IN_WINDOW,
        ): InstanceType<typeof ResilienceDto.StatusChecker> {
            return new ResilienceDto.StatusChecker(
                RateLimiter.init(
                    ResilienceDto.RATE_LIMITER_FAIRNESS_CHECK_SLIDING_WINDOW_DURATION_MS,
                    ResilienceDto.MAX_NUM_IS_ENTRY_CHECK,
                ),
                RateLimiter.init(
                    ResilienceDto.RATE_LIMITER_FAIRNESS_CHECK_SLIDING_WINDOW_DURATION_MS,
                    maxSelectionsInWindow,
                ),
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
        retryPolicy: ResourceInboxRetryPolicy = DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
    ): InstanceType<typeof ResilienceDto> {
        const policy = RateAdjuster.toPolicy(
            initialRate,
            maxRate,
            concurrencyIncreaseStep,
            concurrencyReduceStep,
            ResilienceDto.MIN_CONSECUTIVE_SUCCESSES,
            ResilienceDto.RATE_ADJUST_WINDOW_MS,
        );

        return new ResilienceDto(
            CircuitBreaker.create(circuitBreakerPolicy),
            ResilienceDto.StatusChecker.toReserveEntryTimeoutChecker(),
            ResilienceDto.StatusChecker.toFairnessEntryChecker(maxFairnessSelectionsInWindow),
            ResilienceDto.StatusChecker.toReserveEntryTimeoutChecker(),
            RateAdjuster.create(new RateAdjusterPolicy(
                policy.initialRate,
                policy.maxRate,
                policy.concurrencyIncreaseStep,
                policy.concurrencyReduceStep,
                policy.minConsecutiveSuccesses,
                policy.adjustWindowMs,
            )),
            retryPolicy,
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
        resilience: InstanceType<typeof ResilienceDto>,
        options: DequeueResourceEntryOptions = {},
    ): DequeueController<Resource.Key, ResourceEntry, V> {
        const retryPolicy = resilience.retryPolicy;
        if (
            options.retryPolicy &&
            !isResourceInboxRetryPolicyEqual(options.retryPolicy, retryPolicy)
        ) {
            throw new Error('Dequeue retry policy override must match resilience retry policy');
        }
        if (maxRetries !== retryPolicy.maxAttempts) {
            throw new Error(
                `ResourceInbox retry limit ${maxRetries} must match policy maxAttempts ${retryPolicy.maxAttempts}`,
            );
        }

        const nowEpochMs = options.nowEpochMs ?? Date.now;
        const jitterUnit = options.jitterUnit ?? Math.random;
        const recordReservationTelemetry =
            options.onReservationTelemetry ?? ((event: ResourceInboxFairnessTelemetry) => {
                console.info('ResourceInbox reservation', event);
            });
        const rememberLane = (
            entries: Map<Resource.Key, ResourceEntry>,
            lane: Reservator,
        ): Map<Resource.Key, ResourceEntry> => {
            const selectedAtEpochMs = nowEpochMs();
            for (const entry of entries.values()) {
                rememberResourceInboxAttemptTelemetry(entry, lane, selectedAtEpochMs);
            }
            return entries;
        };

        return DequeueController
            .create<Resource.Key, ResourceEntry, V>()
            .withInboxTypesToDequeue(typesToDequeue)
            .withMaxNumToDequeue(maxNumToDequeue)
            .withMaxNumToReserve(maxToReserve)
            .onFinalizationEntriesReserveDo(options.onRetryExhaustionRecovery
                ? async (types, maxNumToReserve) => {
                    const selectedAtEpochMs = nowEpochMs();
                    const selections = await RateLimiter.tryToExecuteOrDefault(
                        resilience.checkFinalization.lockEntryRateLimiter,
                        () => dequeueResourceEntryRepository.reserveRetryExhaustionFinalizations(
                            types,
                            {
                                processingAttempts: retryPolicy.maxAttempts,
                                maxToReserve: maxNumToReserve,
                                staleAfterMs: DequeueResourceEntryController.FINALIZATION_STALE_AFTER_MS,
                            },
                        ),
                        new Map<Resource.Key, ResourceInboxFinalizationSelection>(),
                    );
                    const entries = new Map<Resource.Key, ResourceEntry>();
                    for (const [key, selection] of selections) {
                        rememberResourceInboxAttemptTelemetry(
                            selection.entry, Reservator.FINALIZATION, selectedAtEpochMs,
                            Number(selection.selectedDueTs.epochMilliseconds),
                        );
                        entries.set(key, selection.entry);
                    }
                    return entries;
                }
                : undefined)
            .onFinalizationEntriesDo(options.onRetryExhaustionRecovery
                ? async (key, entry) => {
                    const finalizedAtEpochMs = nowEpochMs();
                    const recovery = toRetryExhaustionRecovery(
                        entry,
                        retryPolicy.maxAttempts,
                        finalizedAtEpochMs,
                    );
                    await options.onRetryExhaustionRecovery!(recovery);
                    options.onRetryExhaustionTelemetry?.(recovery);
                    return key as V;
                }
                : undefined)
            .onNewEntriesReserveDo(async (types, maxNumToReserve) =>
                rememberLane(await dequeueResourceEntryRepository.reserveEntries(
                    types,
                    new Set([EntityStatus.NEW]),
                    {
                        maxToReserve: maxNumToReserve,
                        maxAttempts: retryPolicy.maxAttempts,
                    },
                ), Reservator.NEW),
            )
            .onRetryEntriesReserveDo(async (types, maxNumToReserve) =>
                rememberLane(await dequeueResourceEntryRepository.reserveEntries(
                    types,
                    new Set([EntityStatus.RETRY]),
                    {
                        maxToReserve: maxNumToReserve,
                        maxAttempts: retryPolicy.maxAttempts,
                    },
                ), Reservator.RETRY),
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
                                    toSaturatedResourceInboxFairnessScanBudget(maxNumToReserve),
                                ),
                            },
                        );
                        for (const selection of reserved.values()) {
                            recordReservationTelemetry(
                                toResourceInboxFairnessTelemetry(
                                    selection,
                                    selectedAtEpochMs,
                                ),
                            );
                            rememberResourceInboxAttemptTelemetry(
                                selection.entry, Reservator.FAIRNESS, selectedAtEpochMs,
                                Number(selection.selectedDueTs.epochMilliseconds),
                            );
                        }
                        return new Map(
                            [...reserved].map(([key, selection]) => [key, selection.entry]),
                        );
                    },
                    new Map<Resource.Key, ResourceEntry>(),
                ),
            )
            .onTimeoutEntriesReserveDo(async (types, maxNumToReserve) => {
                const reservedTimeoutEntries =
                    await RateLimiter.tryToExecuteOrDefault(
                        resilience.checkReserveTimeouts.lockEntryRateLimiter,
                        () =>
                            dequeueResourceEntryRepository.reserveTimeoutEntries(
                                types,
                                {
                                    maxToReserve: maxNumToReserve,
                                    maxAttempts: retryPolicy.maxAttempts,
                                },
                                DequeueResourceEntryController.TIMEOUT_ON_NON_RESPONSIVE_ENTRY_MS
                            ),
                        new Map<Resource.Key, ResourceEntry>(),
                    );

                if (reservedTimeoutEntries.size > 0) {
                    console.info(
                        `${Array.from(types).join(',')} Reserved entries that DNF before TIMEOUT ${DequeueResourceEntryController.TIMEOUT_ON_NON_RESPONSIVE_ENTRY_MS}ms, entries: ${Array.from(reservedTimeoutEntries.keys()).join(',')}`,
                    );
                }

                return rememberLane(reservedTimeoutEntries, Reservator.TIMEOUT);
            })
            .onReleaseEntriesDo(
                // successReleaser
                async (successByKey) => {
                    const released =
                        await dequeueResourceEntryRepository.releaseEntries(
                            Array.from(successByKey.values())
                                .map((dto) => dto.value),
                            { status: EntityStatus.COMPLETED, delayMs: null },
                        );

                    const out = new Map<Resource.Key, SuccessDto<Resource.Key, ResourceEntry, V>>();

                    for (const [k, v] of released.entries()) {
                        const original =
                            Array.from(successByKey.values())
                                .find((dto) => isKeysEqual(dto.key, k));

                        if (!original) {
                            throw new Error(`Missing success dto for key: ${String(k)}`);
                        }

                        recordResourceInboxAttemptRelease(
                            options.onAttemptReleaseTelemetry,
                            original.value,
                            v,
                            'accepted',
                        );
                        out.set(k, new SuccessDto(k, v, original.computedValue));
                    }
                    return out;
                },
                // failureReleaser
                async (failureByKey) => {
                    const out = new Map<Resource.Key, FailureDto<Resource.Key, ResourceEntry>>();
                    for (const failure of failureByKey.values()) {
                        if (failure.exception instanceof ResourceInboxFinalizedByHandlerError) {
                            recordResourceInboxAttemptRelease(
                                options.onAttemptReleaseTelemetry,
                                failure.value,
                                failure.exception.entry,
                                failure.exception.entry.status === EntityStatus.COMPLETED
                                    ? 'accepted'
                                    : 'non-retryable',
                                failure.exception.handlerError,
                            );
                            out.set(
                                failure.key,
                                new FailureDto(
                                    failure.key,
                                    failure.exception.entry,
                                    failure.exception.handlerError,
                                ),
                            );
                            continue;
                        }
                        const nonRetryable =
                            DequeueResourceEntryController.isNonRetryableException(failure);
                        const decision = nonRetryable
                            ? { status: 'failed' as const, delayMs: null }
                            : retryAfterAttempt(
                                retryPolicy,
                                failure.value.dequeueAudit.attempts,
                                jitterUnit(),
                            );
                        let disposition: ResourceInboxReleaseDisposition;
                        if (nonRetryable) {
                            disposition = {
                                status: EntityStatus.NON_RETRYABLE,
                                delayMs: null,
                            };
                        } else if (decision.status === 'retry') {
                            if (decision.delayMs === null) {
                                throw new Error('Retry decision is missing a release delay');
                            }
                            disposition = {
                                status: EntityStatus.RETRY,
                                delayMs: decision.delayMs,
                            };
                        } else if (options.onRetryExhausted) {
                            const exhaustedAtEpochMs = nowEpochMs();
                            const exhaustion = toRetryExhaustion(
                                failure,
                                readResourceInboxAttemptTelemetry(failure.value)?.selectedLane ?? Reservator.NEW,
                                retryPolicy.maxAttempts,
                                exhaustedAtEpochMs,
                            );
                            const finalized = await options.onRetryExhausted(exhaustion);
                            options.onRetryExhaustionTelemetry?.(exhaustion);
                            recordResourceInboxAttemptRelease(
                                options.onAttemptReleaseTelemetry,
                                failure.value, finalized, 'retryable', failure.exception,
                            );
                            out.set(
                                failure.key,
                                new FailureDto(
                                    failure.key,
                                    finalized,
                                    failure.exception,
                                ),
                            );
                            continue;
                        } else {
                            disposition = {
                                status: EntityStatus.FAILED,
                                delayMs: null,
                            };
                        }
                        const released = await dequeueResourceEntryRepository.releaseEntries(
                            [failure.value],
                            disposition,
                        );
                        for (const [k, v] of released.entries()) {
                            const original =
                                Array.from(failureByKey.values())
                                    .find((dto) => isKeysEqual(dto.key, k));
                            if (!original) {
                                throw new Error(`Missing failure dto for key: ${String(k)}`);
                            }

                            recordResourceInboxAttemptRelease(
                                options.onAttemptReleaseTelemetry,
                                original.value,
                                v,
                                nonRetryable ? 'non-retryable' : 'retryable',
                                original.exception,
                            );
                            out.set(k, new FailureDto(k, v, original.exception));
                        }
                    }

                    return out;
                },
            );
    }

    private static isNonRetryableException(
        failure: FailureDto<Resource.Key, ResourceEntry>,
    ): boolean {
        return failure.exception instanceof NonRetryableException;
    }

    // -------------------------
    // Utility conversions
    // -------------------------

    static toFailures<K, V, T>(
        dequeued: Map<Reservator, Map<K, Either<FailureDto<K, V>, SuccessDto<K, V, T>>>>,
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
        dequeued: Map<Reservator, Map<K, Either<FailureDto<K, V>, SuccessDto<K, V, T>>>>,
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
        dequeued: Map<Reservator, Map<K, Either<FailureDto<K, V>, SuccessDto<K, V, T>>>>,
    ): Map<K, Either<RuntimeException, T>> {
        const out = new Map<K, Either<RuntimeException, T>>();

        for (const entry of dequeued.values()) {
            for (const either of entry.values()) {
                const kv = either.fold(
                    (failure) => [failure.key, Either.ofLeft<RuntimeException, T>(failure.exception as RuntimeException)] as const,
                    (success) => [success.key, Either.ofRight<RuntimeException, T>(success.computedValue)] as const,
                );
                out.set(kv[0], kv[1]);
            }
        }

        return out;
    }
}

// TS doesn't have a built-in RuntimeException; in your codebase you may just use Error.
// This alias matches the intent of the Java signature.
export type RuntimeException = Error;

export type DequeueResourceEntryOptions = Readonly<{
    retryPolicy?: ResourceInboxRetryPolicy;
    jitterUnit?: () => number;
    nowEpochMs?: () => number;
    onReservationTelemetry?: (event: ResourceInboxFairnessTelemetry) => void;
    onAttemptReleaseTelemetry?: (event: ResourceInboxAttemptReleaseTelemetry) => void;
    onRetryExhausted?: (
        exhaustion: ResourceInboxRetryExhaustion,
    ) => Promise<ResourceEntry>;
    onRetryExhaustionTelemetry?: (
        exhaustion: ResourceInboxRetryExhaustion | ResourceInboxRetryExhaustionRecovery,
    ) => void;
    onRetryExhaustionRecovery?: (
        exhaustion: ResourceInboxRetryExhaustionRecovery,
    ) => Promise<ResourceEntry>;
}>;

function toRetryExhaustion(
    failure: FailureDto<Resource.Key, ResourceEntry>,
    lane: Reservator,
    processingAttempts: number,
    exhaustedAtEpochMs: number,
): ResourceInboxRetryExhaustion {
    const createdAtEpochMs = Number(
        failure.value.audit.createdTs.toZonedDateTime('UTC').epochMilliseconds,
    );
    const dueAtEpochMs = failure.value.dequeueAudit.nextTs
        ? Number(failure.value.dequeueAudit.nextTs.epochMilliseconds)
        : Number(failure.value.dequeueAudit.startTs?.epochMilliseconds ?? exhaustedAtEpochMs);
    return {
        entry: failure.value,
        processingAttempts,
        reservationAttempt: failure.value.dequeueAudit.attempts,
        lane,
        classification: 'retryable',
        exhausted: true,
        failure: { source: 'processing', error: failure.exception },
        queueAgeMs: Math.max(0, exhaustedAtEpochMs - createdAtEpochMs),
        dueAgeMs: Math.max(0, exhaustedAtEpochMs - dueAtEpochMs),
        exhaustedAtEpochMs,
    };
}

function toRetryExhaustionRecovery(
    entry: ResourceEntry,
    processingAttempts: number,
    finalizedAtEpochMs: number,
): ResourceInboxRetryExhaustionRecovery {
    const telemetry = readResourceInboxAttemptTelemetry(entry);
    if (!telemetry || telemetry.selectedLane !== Reservator.FINALIZATION) {
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
        finalizedAtEpochMs,
    };
}

function isResourceInboxRetryPolicyEqual(
    left: ResourceInboxRetryPolicy,
    right: ResourceInboxRetryPolicy,
): boolean {
    return left.maxAttempts === right.maxAttempts &&
        left.maxDelayMs === right.maxDelayMs &&
        left.jitterRatio === right.jitterRatio &&
        left.staleDueThresholdMs === right.staleDueThresholdMs &&
        left.delaysAfterAttemptMs.length === right.delaysAfterAttemptMs.length &&
        left.delaysAfterAttemptMs.every(
            (delayMs, index) => delayMs === right.delaysAfterAttemptMs[index],
        );
}
