import { CircuitBreaker, type CircuitBreakerPolicy } from '../../resilience/circuit-breaker.ts';
import { RateLimiter } from '../../resilience/Resilience.ts';
import type { ResourceInboxWorkAdvertisementOptions } from '../queue-box-types.ts';
import { TIMEOUT_ON_NON_RESPONSIVE_ENTRY } from '../ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY, type ResourceInboxRetryPolicy } from '../ResourceInboxRetryPolicy.ts';

export namespace ResourceInboxResilience {
    export interface StatusChecks {
        readonly lockEntryRateLimiter: RateLimiter;
    }

    export interface Dependencies {
        readonly circuitBreaker: CircuitBreaker;
        readonly checkReserveTimeouts: StatusChecks;
        readonly checkFinalization: StatusChecks;
        readonly retryPolicy: ResourceInboxRetryPolicy;
        /** How long a claim may stay RESERVED before the TIMEOUT lane reclaims it from its absent owner. */
        readonly reservationLeaseMs: number;
    }

    export interface DefaultConfig {
        readonly circuitBreakerPolicy: CircuitBreakerPolicy;
        readonly retryPolicy?: ResourceInboxRetryPolicy;
        readonly reservationLeaseMs?: number;
    }
}

export class ResourceInboxResilience {
    static readonly MAX_NUM_DEQUEUE_IN_WINDOW = 10;
    /** The opportunistic expired-row sweep a queue runs beside its probe: at most once per window. */
    static readonly MAX_NUM_CLEANUP_IN_WINDOW = 1;
    static readonly RATE_LIMITER_RESERVED_TIMEOUT_SLIDING_WINDOW_DURATION_MS = 60_000;
    static readonly FINALIZATION_STALE_AFTER_MS = 5 * 60_000;
    static readonly DEFAULT_RESERVATION_LEASE_MS = TIMEOUT_ON_NON_RESPONSIVE_ENTRY.total({ unit: 'milliseconds' });

    readonly circuitBreaker: CircuitBreaker;
    readonly checkReserveTimeouts: ResourceInboxResilience.StatusChecks;
    readonly checkFinalization: ResourceInboxResilience.StatusChecks;
    readonly retryPolicy: ResourceInboxRetryPolicy;
    readonly reservationLeaseMs: number;

    constructor(dependencies: ResourceInboxResilience.Dependencies) {
        this.circuitBreaker = dependencies.circuitBreaker;
        this.checkReserveTimeouts = dependencies.checkReserveTimeouts;
        this.checkFinalization = dependencies.checkFinalization;
        this.retryPolicy = dependencies.retryPolicy;
        this.reservationLeaseMs = dependencies.reservationLeaseMs;
    }

    static createDefault(config: ResourceInboxResilience.DefaultConfig): ResourceInboxResilience {
        return new ResourceInboxResilience({
            circuitBreaker: CircuitBreaker.create(config.circuitBreakerPolicy),
            checkReserveTimeouts: createResourceInboxStatusChecks(
                ResourceInboxResilience.MAX_NUM_DEQUEUE_IN_WINDOW,
                ResourceInboxResilience.RATE_LIMITER_RESERVED_TIMEOUT_SLIDING_WINDOW_DURATION_MS
            ),
            checkFinalization: createResourceInboxStatusChecks(
                ResourceInboxResilience.MAX_NUM_DEQUEUE_IN_WINDOW,
                ResourceInboxResilience.RATE_LIMITER_RESERVED_TIMEOUT_SLIDING_WINDOW_DURATION_MS
            ),
            retryPolicy: config.retryPolicy ?? DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
            reservationLeaseMs: config.reservationLeaseMs ?? ResourceInboxResilience.DEFAULT_RESERVATION_LEASE_MS
        });
    }

    toWorkAdvertisementOptions(): ResourceInboxWorkAdvertisementOptions {
        return {
            maxAttempts: this.retryPolicy.maxAttempts,
            finalizationStaleAfterMs: ResourceInboxResilience.FINALIZATION_STALE_AFTER_MS,
            reservationLeaseMs: this.reservationLeaseMs,
            staleDueThresholdMs: this.retryPolicy.staleDueThresholdMs
        };
    }

    success(): void {
        this.circuitBreaker.success();
    }

    failure(): void {
        this.circuitBreaker.failure();
    }

    isNotAllowedThroughToDequeue(): boolean {
        return !this.circuitBreaker.isAllowedThrough();
    }

    /** The first instant a tripped breaker lets a dequeue through again, or `undefined` while it already does. */
    getDequeueReopenAtMs(nowEpochMs: number): number | undefined {
        const breaker = this.circuitBreaker;
        if (breaker.isAllowedThroughAt(nowEpochMs)) {
            return undefined;
        }
        return breaker.isHalfOpen()
            ? breaker.timestampHalfOpen.get() + breaker.policy.halfOpenTimeout.total({ unit: 'milliseconds' }) + 1
            : breaker.timestampOpen.get() + breaker.policy.resetTimeout.total({ unit: 'milliseconds' }) + 1;
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
        lockEntryRateLimiter: RateLimiter.init(
            windowDurationMs,
            maxSelectionsInWindow
        )
    };
}
