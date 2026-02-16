import {Either, EitherCollectors} from "../resilience/Either.ts";
import {
    CircuitBreaker,
    CircuitBreakerPolicy,
    RateAdjuster,
    RateAdjusterPolicy,
    RateLimiter
} from "../resilience/Resilience.ts";
import {DequeueController, FailureDto, Reservator, SuccessDto} from "./DequeueController.ts";
import {DequeueResourceEntryRepository} from "./QueueBoxTypes.ts";
import * as Resource from "./ResourceEntry.ts";
import {EntityStatus, ResourceEntry} from "./ResourceEntry.ts";

// -----------------------------------------
// Minimal domain contracts (adjust/import)
// -----------------------------------------

export class NonRetryableException extends Error {
    constructor(message?: string) {
        super(message);
        this.name = "NonRetryableException";
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
    static readonly RATE_LIMITER_FAILED_CHECK_SLIDING_WINDOW_DURATION_MS = 60 * 60 * 1000;

    static readonly MIN_CONSECUTIVE_SUCCESSES = 10;
    // Duration.ofMinutes(15)
    static readonly RATE_ADJUST_WINDOW_MS = 15 * 60 * 1000;

    constructor(
        public readonly circuitBreaker: CircuitBreaker,
        public readonly checkReserveTimeouts: InstanceType<typeof ResilienceDto.StatusChecker>,
        public readonly checkFailed: InstanceType<typeof ResilienceDto.StatusChecker>,
        public readonly rateAdjuster: RateAdjuster,
    ) {
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

        static toFailedEntryChecker(): InstanceType<typeof ResilienceDto.StatusChecker> {
            return new ResilienceDto.StatusChecker(
                RateLimiter.init(
                    ResilienceDto.RATE_LIMITER_FAILED_CHECK_SLIDING_WINDOW_DURATION_MS,
                    ResilienceDto.MAX_NUM_IS_ENTRY_CHECK,
                ),
                RateLimiter.init(
                    ResilienceDto.RATE_LIMITER_FAILED_CHECK_SLIDING_WINDOW_DURATION_MS,
                    ResilienceDto.MAX_NUM_DEQUEUE_IN_WINDOW,
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
            ResilienceDto.StatusChecker.toFailedEntryChecker(),
            RateAdjuster.create(new RateAdjusterPolicy(
                policy.initialRate,
                policy.maxRate,
                policy.concurrencyIncreaseStep,
                policy.concurrencyReduceStep,
                policy.minConsecutiveSuccesses,
                policy.adjustWindowMs,
            )),
        );
    }
};

// -----------------------------------------
// Converted DequeueResourceEntry
// -----------------------------------------

export class DequeueResourceEntryController {
    static readonly TIMEOUT_ON_NON_RESPONSIVE_ENTRY_MS = Temporal.Duration.from({milliseconds: 5 * 60 * 1000});

    private static readonly RETRY_EXPONENTIAL_BACKOFF_STEPS: Temporal.TimeUnit = "second";
    private static readonly FAILED_EXPONENTIAL_BACKOFF_STEPS: Temporal.TimeUnit = "hour";

    // -------------------------
    // Java record ResilienceDto
    // -------------------------
    public static toDequeuer<V>(
        dequeueResourceEntryRepository: DequeueResourceEntryRepository,
        typesToDequeue: () => Set<string>,
        maxToReserve: () => number,
        maxRetries: number,
        maxNumToDequeue: number,
        resilience: InstanceType<typeof ResilienceDto>
    ): DequeueController<Resource.Key, ResourceEntry, V> {
        return DequeueController
            .create<Resource.Key, ResourceEntry, V>()
            .withInboxTypesToDequeue(typesToDequeue)
            .withMaxNumToDequeue(maxNumToDequeue)
            .withMaxNumToReserve(maxToReserve)
            .onNewEntriesReserveDo(async (types, maxNumToReserve) =>
                await dequeueResourceEntryRepository.reserveEntries(
                    types,
                    new Set([EntityStatus.NEW]),
                    maxNumToReserve
                ),
            )
            .onRetryEntriesReserveDo(async (types, maxNumToReserve) =>
                await dequeueResourceEntryRepository.reserveEntries(
                    types,
                    new Set([EntityStatus.RETRY]),
                    maxNumToReserve
                ),
            )
            .onFailedEntriesReserveDo(async (types, maxNumToReserve) =>
                await RateLimiter.tryToExecuteOrDefault(
                    resilience.checkFailed.lockEntryRateLimiter,
                    () =>
                        dequeueResourceEntryRepository.reserveEntries(
                            types,
                            new Set([EntityStatus.FAILED]),
                            maxNumToReserve
                        ),
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
                                maxNumToReserve,
                                DequeueResourceEntryController.TIMEOUT_ON_NON_RESPONSIVE_ENTRY_MS
                            ),
                        new Map<Resource.Key, ResourceEntry>(),
                    );

                if (reservedTimeoutEntries.size > 0) {
                    console.info(
                        `${Array.from(types).join(",")} Reserved entries that DNF before TIMEOUT ${DequeueResourceEntryController.TIMEOUT_ON_NON_RESPONSIVE_ENTRY_MS}ms, entries: ${Array.from(reservedTimeoutEntries.keys()).join(",")}`,
                    );
                }

                return reservedTimeoutEntries;
            })
            .onReleaseEntriesDo(
                // successReleaser
                async (successByKey) => {
                    const released =
                        await dequeueResourceEntryRepository.releaseEntries(
                            Array.from(successByKey.values()).map((dto) => dto.value),
                            EntityStatus.COMPLETED,
                            undefined,
                        );

                    const out = new Map<Resource.Key, SuccessDto<Resource.Key, ResourceEntry, V>>();
                    for (const [k, v] of released.entries()) {
                        const original = successByKey.get(k);
                        if (!original) {
                            throw new Error(`Missing success dto for key: ${String(k)}`);
                        }
                        out.set(k, new SuccessDto(k, v, original.computedValue));
                    }
                    return out;
                },

                // failureReleaser
                async (failureByKey) => {
                    // Group by next status
                    const grouped = new Map<EntityStatus, FailureDto<Resource.Key, ResourceEntry>[]>();

                    for (const failure of failureByKey.values()) {
                        const nextStatus =
                            DequeueResourceEntryController.isNonRetryableException(failure)
                                ? EntityStatus.NON_RETRYABLE
                                : failure.value.dequeueAudit.attempts < maxRetries
                                    ? EntityStatus.RETRY
                                    : EntityStatus.FAILED;

                        const list = grouped.get(nextStatus) ?? [];
                        list.push(failure);
                        grouped.set(nextStatus, list);
                    }

                    // Release per group and flatten
                    const out = new Map<Resource.Key, FailureDto<Resource.Key, ResourceEntry>>();

                    for (const [status, failures] of grouped.entries()) {
                        const released =
                            await dequeueResourceEntryRepository.releaseEntries(
                                failures.map((f) => f.value),
                                status,
                                status === EntityStatus.RETRY
                                    ? DequeueResourceEntryController.RETRY_EXPONENTIAL_BACKOFF_STEPS
                                    : DequeueResourceEntryController.FAILED_EXPONENTIAL_BACKOFF_STEPS,
                            );

                        for (const [k, v] of released.entries()) {
                            const original = failureByKey.get(k);
                            if (!original) {
                                throw new Error(`Missing failure dto for key: ${String(k)}`);
                            }
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