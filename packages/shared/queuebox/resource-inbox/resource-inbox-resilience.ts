import { CircuitBreaker, type CircuitBreakerPolicy } from '../../resilience/circuit-breaker.ts';
import {
    RateAdjuster,
    RateAdjusterPolicy,
    RateLimiter
} from '../../resilience/Resilience.ts';
import type { ResourceInboxWorkAdvertisementOptions } from '../queue-box-types.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY, type ResourceInboxRetryPolicy } from '../ResourceInboxRetryPolicy.ts';

export namespace ResourceInboxResilience {
    export interface StatusChecks {
        readonly isEntryRateLimiter: RateLimiter;
        readonly lockEntryRateLimiter: RateLimiter;
    }

    export interface Dependencies {
        readonly circuitBreaker: CircuitBreaker;
        readonly checkReserveTimeouts: StatusChecks;
        readonly checkFairness: StatusChecks;
        readonly checkFinalization: StatusChecks;
        readonly rateAdjuster: RateAdjuster;
        readonly retryPolicy: ResourceInboxRetryPolicy;
    }

    export interface DefaultConfig {
        readonly circuitBreakerPolicy: CircuitBreakerPolicy;
        readonly initialRate: number;
        readonly maxRate: number;
        readonly concurrencyIncreaseStep: number;
        readonly concurrencyReduceStep: number;
        readonly maxFairnessSelectionsInWindow?: number;
        readonly retryPolicy?: ResourceInboxRetryPolicy;
    }
}

export class ResourceInboxResilience {
    static readonly MAX_NUM_IS_ENTRY_CHECK = 1;
    static readonly MAX_NUM_DEQUEUE_IN_WINDOW = 10;
    static readonly RATE_LIMITER_RESERVED_TIMEOUT_SLIDING_WINDOW_DURATION_MS = 60_000;
    static readonly RATE_LIMITER_FAIRNESS_CHECK_SLIDING_WINDOW_DURATION_MS = 60_000;
    static readonly MIN_CONSECUTIVE_SUCCESSES = 10;
    static readonly RATE_ADJUST_WINDOW_MS = 15 * 60_000;
    static readonly FINALIZATION_STALE_AFTER_MS = 5 * 60_000;

    readonly circuitBreaker: CircuitBreaker;
    readonly checkReserveTimeouts: ResourceInboxResilience.StatusChecks;
    readonly checkFairness: ResourceInboxResilience.StatusChecks;
    readonly checkFinalization: ResourceInboxResilience.StatusChecks;
    readonly rateAdjuster: RateAdjuster;
    readonly retryPolicy: ResourceInboxRetryPolicy;

    constructor(dependencies: ResourceInboxResilience.Dependencies) {
        this.circuitBreaker = dependencies.circuitBreaker;
        this.checkReserveTimeouts = dependencies.checkReserveTimeouts;
        this.checkFairness = dependencies.checkFairness;
        this.checkFinalization = dependencies.checkFinalization;
        this.rateAdjuster = dependencies.rateAdjuster;
        this.retryPolicy = dependencies.retryPolicy;
    }

    static createDefault(config: ResourceInboxResilience.DefaultConfig): ResourceInboxResilience {
        const policy = RateAdjuster.toPolicy(
            config.initialRate,
            config.maxRate,
            config.concurrencyIncreaseStep,
            config.concurrencyReduceStep,
            ResourceInboxResilience.MIN_CONSECUTIVE_SUCCESSES,
            ResourceInboxResilience.RATE_ADJUST_WINDOW_MS
        );
        return new ResourceInboxResilience({
            circuitBreaker: CircuitBreaker.create(config.circuitBreakerPolicy),
            checkReserveTimeouts: createResourceInboxStatusChecks(
                ResourceInboxResilience.MAX_NUM_DEQUEUE_IN_WINDOW,
                ResourceInboxResilience.RATE_LIMITER_RESERVED_TIMEOUT_SLIDING_WINDOW_DURATION_MS
            ),
            checkFairness: createResourceInboxStatusChecks(
                config.maxFairnessSelectionsInWindow ?? ResourceInboxResilience.MAX_NUM_DEQUEUE_IN_WINDOW,
                ResourceInboxResilience.RATE_LIMITER_FAIRNESS_CHECK_SLIDING_WINDOW_DURATION_MS
            ),
            checkFinalization: createResourceInboxStatusChecks(
                ResourceInboxResilience.MAX_NUM_DEQUEUE_IN_WINDOW,
                ResourceInboxResilience.RATE_LIMITER_RESERVED_TIMEOUT_SLIDING_WINDOW_DURATION_MS
            ),
            rateAdjuster: RateAdjuster.create(
                new RateAdjusterPolicy(
                    policy.initialRate,
                    policy.maxRate,
                    policy.concurrencyIncreaseStep,
                    policy.concurrencyReduceStep,
                    policy.minConsecutiveSuccesses,
                    policy.adjustWindowMs
                )
            ),
            retryPolicy: config.retryPolicy ?? DEFAULT_RESOURCE_INBOX_RETRY_POLICY
        });
    }

    toWorkAdvertisementOptions(): ResourceInboxWorkAdvertisementOptions {
        return {
            checkTimeout: this.checkReserveTimeouts.isEntryRateLimiter,
            checkFairness: this.checkFairness.isEntryRateLimiter,
            checkFinalization: this.checkFinalization.isEntryRateLimiter,
            maxAttempts: this.retryPolicy.maxAttempts,
            finalizationStaleAfterMs: ResourceInboxResilience.FINALIZATION_STALE_AFTER_MS
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

    isNotAllowedThroughToDequeue(): boolean {
        return !this.circuitBreaker.isAllowedThrough();
    }

    /** How long a tripped breaker stays open: the wait a rejected dequeue owes before its next attempt. */
    toCircuitOpenBackoffMs(): number {
        return this.circuitBreaker.policy.resetTimeout.total({ unit: 'milliseconds' });
    }
}

function createResourceInboxStatusChecks(
    maxSelectionsInWindow: number,
    windowDurationMs: number
): ResourceInboxResilience.StatusChecks {
    return {
        isEntryRateLimiter: RateLimiter.init(
            windowDurationMs,
            ResourceInboxResilience.MAX_NUM_IS_ENTRY_CHECK
        ),
        lockEntryRateLimiter: RateLimiter.init(
            windowDurationMs,
            maxSelectionsInWindow
        )
    };
}
