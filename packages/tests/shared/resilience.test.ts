import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreaker, CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import {
    RateAdjuster,
    RateLimiter,
    SlidingWindowCounter,
} from '@shared/resilience/Resilience.ts';

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
                Temporal.Duration.from({ seconds: 1 }),
            ),
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

    it('increases and reduces the calculated rate based on success and failure', () => {
        const adjuster = RateAdjuster.create(
            RateAdjuster.toPolicy(1, 4, 1, 1, 2, 1_000),
        );

        adjuster.success();
        expect(adjuster.calculateRate()).toBe(1);

        adjuster.success();
        expect(adjuster.calculateRate()).toBe(2);

        adjuster.failure();
        expect(adjuster.calculateRate()).toBe(1);
    });

    it('enforces rate limiting and returns defaults when execution is blocked', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const limiter = RateLimiter.init(100, 2);

        expect(limiter.allow()).toBe(true);
        expect(limiter.allow()).toBe(true);
        expect(limiter.allow()).toBe(false);

        await expect(
            RateLimiter.tryToExecuteOrDefault(limiter, async () => 5, 9),
        ).resolves.toBe(9);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.150Z'));

        expect(limiter.allow()).toBe(true);
        await expect(
            RateLimiter.tryToExecuteOrDefault(limiter, async () => 7, 9),
        ).resolves.toBe(7);
    });

    it('executes the fallback supplier when rate limiting blocks execution', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const limiter = RateLimiter.init(100, 1);
        const supplier = vi.fn(async () => 'allowed');
        const fallback = vi.fn(async () => 'blocked');

        await expect(
            RateLimiter.tryToExecuteOrElse(limiter, supplier, fallback),
        ).resolves.toBe('allowed');
        await expect(
            RateLimiter.tryToExecuteOrElse(limiter, supplier, fallback),
        ).resolves.toBe('blocked');

        expect(supplier).toHaveBeenCalledTimes(1);
        expect(fallback).toHaveBeenCalledTimes(1);
    });
});
