import { RateLimiter } from '@shared/resilience/rate-limiter.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('RateLimiter', () => {
    afterEach(() => {
        vi.useRealTimers();
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
        const ran: string[] = [];
        const supplier = async () => {
            ran.push('supplier');
            return 'allowed';
        };
        const fallback = async () => {
            ran.push('fallback');
            return 'blocked';
        };

        await expect(
            RateLimiter.tryToExecuteOrElse(limiter, supplier, fallback)
        ).resolves.toBe('allowed');
        await expect(
            RateLimiter.tryToExecuteOrElse(limiter, supplier, fallback)
        ).resolves.toBe('blocked');

        expect(ran).toEqual(['supplier', 'fallback']);
    });
});

describe('RateLimiter at a given time', () => {
    it('answers whether it allows at a given time without spending its allowance', () => {
        const limiter = RateLimiter.initWithTs(100, 1, 1_000);

        expect(limiter.isAllowedAt(1_000)).toBe(true);
        expect(limiter.isAllowedAt(1_000)).toBe(true);
        expect(limiter.allowAt(1_010)).toBe(true);
        expect(limiter.isAllowedAt(1_050)).toBe(false);
        expect(limiter.isAllowedAt(1_200)).toBe(true);
    });

    // A clock that stepped back behind the limiter's creation must read as its creation, not throw.
    it('reads a time before its creation as its creation', () => {
        const limiter = RateLimiter.initWithTs(100, 1, 1_000);

        expect(limiter.isAllowedAt(0)).toBe(true);
        expect(limiter.allowAt(0)).toBe(true);
        expect(limiter.isAllowedAt(0)).toBe(false);
        expect(limiter.allowAt(999)).toBe(false);
    });
});
