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

describe('RateLimiter as a token bucket', () => {
    const t0 = 1_791_883_286_000;
    const lateJitterMs = [0, 7, 25, 3, 18, 11, 0, 22, 5, 14];

    function countAdmitted(limiter: RateLimiter, instants: readonly number[]): number {
        return instants.filter((instant) => limiter.allowAt(instant)).length;
    }

    function toJitteredGrid(sendCount: number): number[] {
        return Array.from({ length: sendCount }, (_, index) => t0 + index * 50 + lateJitterMs[index % lateJitterMs.length]!);
    }

    it('admits every send of a 20 Hz stream with late timer jitter at a limit of 20 per second', () => {
        const limiter = RateLimiter.initWithTs(1_000, 20, t0);

        expect(countAdmitted(limiter, toJitteredGrid(600))).toBe(600);
    });

    it('admits every send of a 20 Hz stream that stalls 300 ms and then catches up', () => {
        const limiter = RateLimiter.initWithTs(1_000, 20, t0);
        const instants = toJitteredGrid(600);
        const stallEndMs = t0 + 200 * 50 + 300;
        for (let offset = 0; offset < 6; offset++) {
            instants[200 + offset] = stallEndMs + offset * 2;
        }

        expect(countAdmitted(limiter, instants)).toBe(600);
    });

    it('caps a sustained 40 Hz stream at the declared rate plus one full bucket', () => {
        const limiter = RateLimiter.initWithTs(1_000, 20, t0);
        const admitted = countAdmitted(limiter, Array.from({ length: 400 }, (_, index) => t0 + index * 25));

        expect(admitted).toBeGreaterThanOrEqual(200);
        expect(admitted).toBeLessThanOrEqual(20 + 200);
    });

    it('admits one full bucket in a burst and refills it at the declared rate', () => {
        const limiter = RateLimiter.initWithTs(1_000, 20, t0);

        expect(countAdmitted(limiter, Array.from({ length: 25 }, () => t0))).toBe(20);
        expect(countAdmitted(limiter, Array.from({ length: 25 }, () => t0 + 500))).toBe(10);
    });

    it('admits exactly one per window at a limit of one', () => {
        const limiter = RateLimiter.initWithTs(1_000, 1, t0);

        expect(limiter.allowAt(t0)).toBe(true);
        expect(limiter.allowAt(t0 + 999)).toBe(false);
        expect(limiter.allowAt(t0 + 1_000)).toBe(true);
    });

    it('neither refills nor throws on a clock that steps back behind its last call', () => {
        const limiter = RateLimiter.initWithTs(1_000, 2, t0);

        expect(limiter.allowAt(t0 + 5_000)).toBe(true);
        expect(limiter.allowAt(t0 + 5_000)).toBe(true);
        expect(limiter.allowAt(t0 + 4_000)).toBe(false);
        expect(limiter.isAllowedAt(t0 + 4_999)).toBe(false);
        expect(limiter.allowAt(t0 + 5_500)).toBe(true);
        expect(limiter.allowAt(t0 + 5_500)).toBe(false);
    });

    it('holds no more than one full bucket after hours idle', () => {
        const limiter = RateLimiter.initWithTs(1_000, 20, t0);
        const afterHoursMs = t0 + 5 * 60 * 60_000;

        expect(countAdmitted(limiter, Array.from({ length: 30 }, () => afterHoursMs))).toBe(20);
    });

    it('spends nothing on repeated refusals and admits again at the refill boundary, not one millisecond earlier', () => {
        const limiter = RateLimiter.initWithTs(1_000, 20, t0);

        expect(countAdmitted(limiter, Array.from({ length: 20 }, () => t0))).toBe(20);
        expect(countAdmitted(limiter, [t0 + 10, t0 + 20, t0 + 30])).toBe(0);
        expect(limiter.allowAt(t0 + 49)).toBe(false);
        expect(limiter.allowAt(t0 + 50)).toBe(true);
        expect(limiter.allowAt(t0 + 50)).toBe(false);
    });

    it('answers isAllowedAt without spending a token', () => {
        const limiter = RateLimiter.initWithTs(1_000, 2, t0);

        for (let check = 0; check < 5; check++) {
            expect(limiter.isAllowedAt(t0)).toBe(true);
        }
        expect(countAdmitted(limiter, [t0, t0, t0])).toBe(2);
        expect(limiter.isAllowedAt(t0 + 499)).toBe(false);
        expect(limiter.isAllowedAt(t0 + 500)).toBe(true);
        expect(limiter.isAllowedAt(t0 + 500)).toBe(true);
    });
});
