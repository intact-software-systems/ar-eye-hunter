import { Temporal } from '@js-temporal/polyfill';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { CircuitBreaker, CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { RateLimiter, SlidingWindowCounter } from '@shared/resilience/Resilience.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Resilience', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('expires old sliding-window counts outside the active window', () => {
        const counter = SlidingWindowCounter.initWithTs(100, 25, 0);

        SlidingWindowCounter.updateWithNow(counter, 1, 0);
        SlidingWindowCounter.updateWithNow(counter, 2, 20);
        SlidingWindowCounter.updateWithNow(counter, 3, 70);

        expect(SlidingWindowCounter.sumInWindowWithNow(counter, 70)).toBe(6);
        expect(SlidingWindowCounter.sumInWindowWithNow(counter, 150)).toBe(3);
    });

    it('opens, half-opens, and recloses the circuit breaker based on time and success', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const breaker = CircuitBreaker.create(
            new CircuitBreakerPolicy(
                1,
                Temporal.Duration.from({ milliseconds: 100 }),
                Temporal.Duration.from({ milliseconds: 50 }),
                Temporal.Duration.from({ seconds: 1 })
            )
        );

        breaker.failure();
        breaker.failure();

        expect(breaker.isOpen()).toBe(true);
        expect(breaker.allow()).toBe(false);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.101Z'));
        expect(breaker.isAllowedThrough()).toBe(true);
        expect(breaker.allow()).toBe(true);
        expect(breaker.isHalfOpen()).toBe(true);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.160Z'));
        expect(breaker.allow()).toBe(false);
        expect(breaker.isOpen()).toBe(true);

        breaker.success();
        expect(breaker.isClosed()).toBe(true);
    });

    // Same state machine as the test above, driven entirely by passed-in
    // timestamps: no global clock is replaced, so this cannot perturb timers or
    // async scheduling elsewhere in the file.
    it('drives the whole circuit-breaker lifecycle from a supplied clock', () => {
        const breaker = CircuitBreaker.createWithTs(
            new CircuitBreakerPolicy(
                1,
                Temporal.Duration.from({ milliseconds: 100 }),
                Temporal.Duration.from({ milliseconds: 50 }),
                Temporal.Duration.from({ seconds: 1 })
            ),
            0
        );

        breaker.failureAt(0);
        breaker.failureAt(0);
        expect(breaker.isOpen()).toBe(true);
        expect(breaker.allowAt(0)).toBe(false);

        // Past the reset timeout: the next probe is let through as half-open.
        expect(breaker.isAllowedThroughAt(101)).toBe(true);
        expect(breaker.allowAt(101)).toBe(true);
        expect(breaker.isHalfOpen()).toBe(true);

        // Half-open outlived its timeout without a success, so it trips again.
        expect(breaker.allowAt(160)).toBe(false);
        expect(breaker.isOpen()).toBe(true);

        breaker.successAt(160);
        expect(breaker.isClosed()).toBe(true);
    });

    // Guards the delegation: the wall-clock methods now route through the *At
    // variants, so a drift between the two would otherwise be silent.
    it('leaves the wall-clock entry points behaving exactly as before', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const policy = new CircuitBreakerPolicy(
            1,
            Temporal.Duration.from({ milliseconds: 100 }),
            Temporal.Duration.from({ milliseconds: 50 }),
            Temporal.Duration.from({ seconds: 1 })
        );
        const wallClock = CircuitBreaker.create(policy);
        const supplied = CircuitBreaker.createWithTs(policy, 0);

        wallClock.failure();
        supplied.failureAt(0);
        expect(wallClock.isOpen()).toBe(supplied.isOpen());

        wallClock.failure();
        supplied.failureAt(0);
        expect(wallClock.isOpen()).toBe(true);
        expect(supplied.isOpen()).toBe(true);
        expect(wallClock.allow()).toBe(supplied.allowAt(0));

        vi.setSystemTime(new Date('2026-01-01T00:00:00.101Z'));
        expect(wallClock.allow()).toBe(supplied.allowAt(101));
        expect(wallClock.isHalfOpen()).toBe(supplied.isHalfOpen());
    });

    it('feeds queue outcomes to the circuit breaker alone and keeps the retry policy and lease', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const resilience = ResourceInboxResilience.createDefault({
            circuitBreakerPolicy: new CircuitBreakerPolicy(
                1,
                Temporal.Duration.from({ milliseconds: 100 }),
                Temporal.Duration.from({ milliseconds: 50 }),
                Temporal.Duration.from({ seconds: 1 })
            )
        });

        expect(Object.hasOwn(resilience, 'rateAdjuster')).toBe(false);
        resilience.failure();
        resilience.failure();
        expect(resilience.isNotAllowedThroughToDequeue()).toBe(true);
        expect(resilience.getDequeueReopenAtMs(Date.now())).toBe(Date.now() + 101);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.101Z'));
        expect(resilience.circuitBreaker.allow()).toBe(true);
        resilience.success();
        expect(resilience.circuitBreaker.isClosed()).toBe(true);
        expect(resilience.isNotAllowedThroughToDequeue()).toBe(false);
        expect(resilience.toWorkAdvertisementOptions()).toEqual({
            maxAttempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
            finalizationStaleAfterMs: ResourceInboxResilience.FINALIZATION_STALE_AFTER_MS,
            reservationLeaseMs: ResourceInboxResilience.DEFAULT_RESERVATION_LEASE_MS,
            staleDueThresholdMs: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.staleDueThresholdMs
        });
    });

    it('enforces rate limiting and returns defaults when execution is blocked', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const limiter = RateLimiter.init(100, 2);

        expect(limiter.allow()).toBe(true);
        expect(limiter.allow()).toBe(true);
        expect(limiter.allow()).toBe(false);

        await expect(
            RateLimiter.tryToExecuteOrDefault(limiter, async () => 5, 9)
        ).resolves.toBe(9);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.150Z'));

        expect(limiter.allow()).toBe(true);
        await expect(
            RateLimiter.tryToExecuteOrDefault(limiter, async () => 7, 9)
        ).resolves.toBe(7);
    });

    it('executes the fallback supplier when rate limiting blocks execution', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const limiter = RateLimiter.init(100, 1);
        const supplier = vi.fn(async () => 'allowed');
        const fallback = vi.fn(async () => 'blocked');

        await expect(
            RateLimiter.tryToExecuteOrElse(limiter, supplier, fallback)
        ).resolves.toBe('allowed');
        await expect(
            RateLimiter.tryToExecuteOrElse(limiter, supplier, fallback)
        ).resolves.toBe('blocked');

        expect(supplier).toHaveBeenCalledTimes(1);
        expect(fallback).toHaveBeenCalledTimes(1);
    });
});
