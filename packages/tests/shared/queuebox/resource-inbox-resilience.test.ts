import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';

function toBreakerPolicy(): CircuitBreakerPolicy {
    return new CircuitBreakerPolicy(
        1,
        Temporal.Duration.from({ milliseconds: 100 }),
        Temporal.Duration.from({ milliseconds: 50 }),
        Temporal.Duration.from({ seconds: 1 })
    );
}

describe('ResourceInboxResilience', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('feeds queue outcomes to the circuit breaker alone', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const resilience = ResourceInboxResilience.createDefault(toBreakerPolicy());

        resilience.failure();
        resilience.failure();
        expect(resilience.isNotAllowedThroughToDequeue()).toBe(true);
        expect(resilience.getDequeueReopenAtMs(Date.now())).toBe(Date.now() + 101);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.101Z'));
        expect(resilience.circuitBreaker.allow()).toBe(true);
        resilience.success();
        expect(resilience.circuitBreaker.isClosed()).toBe(true);
        expect(resilience.isNotAllowedThroughToDequeue()).toBe(false);
    });

    it('builds the default retry policy and reservation lease beside the given breaker policy', () => {
        const breakerPolicy = toBreakerPolicy();
        const resilience = ResourceInboxResilience.createDefault(breakerPolicy);

        expect(resilience.circuitBreaker.policy).toBe(breakerPolicy);
        expect(resilience.toWorkAdvertisementOptions()).toEqual({
            maxAttempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
            finalizationStaleAfterMs: ResourceInboxResilience.FINALIZATION_STALE_AFTER_MS,
            reservationLeaseMs: ResourceInboxResilience.DEFAULT_RESERVATION_LEASE_MS,
            staleDueThresholdMs: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.staleDueThresholdMs
        });
    });

    it('takes the breaker policy, retry policy and reservation lease from an explicit input', () => {
        const breakerPolicy = toBreakerPolicy();
        const retryPolicy = { ...DEFAULT_RESOURCE_INBOX_RETRY_POLICY, maxAttempts: 3, staleDueThresholdMs: 7 };
        const resilience = ResourceInboxResilience.create({ circuitBreakerPolicy: breakerPolicy, retryPolicy, reservationLeaseMs: 1_234 });

        expect(resilience.circuitBreaker.policy).toBe(breakerPolicy);
        expect(resilience.retryPolicy).toBe(retryPolicy);
        expect(resilience.toWorkAdvertisementOptions()).toEqual({
            maxAttempts: 3,
            finalizationStaleAfterMs: ResourceInboxResilience.FINALIZATION_STALE_AFTER_MS,
            reservationLeaseMs: 1_234,
            staleDueThresholdMs: 7
        });
    });
});
