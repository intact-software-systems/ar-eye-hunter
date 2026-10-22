import { Temporal } from '@js-temporal/polyfill';
import { CircuitBreaker, CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('CircuitBreaker', () => {
    afterEach(() => {
        vi.useRealTimers();
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
});
