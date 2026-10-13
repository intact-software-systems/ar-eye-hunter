import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { computeRateLimiterRetryAfterMs } from '@shared/resilience/compute-rate-limiter-retry-after-ms.ts';
import { RateLimiter } from '@shared/resilience/Resilience.ts';

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

describe('RateLimiter relative readiness', () => {
    it('returns exact inclusive default bucket expiry without spending or clearing the allowance', () => {
        let now = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        onTestFinished(() => {
            vi.restoreAllMocks();
        });
        const limiter = RateLimiter.init(1_000, 20);
        expect(computeRateLimiterRetryAfterMs(limiter, Date.now())).toBe(0);
        for (let token = 0; token < 20; token++) {
            expect(computeRateLimiterRetryAfterMs(limiter, Date.now())).toBe(0);
            expect(limiter.allow()).toBe(true);
        }
        expect(computeRateLimiterRetryAfterMs(limiter, Date.now())).toBe(1251);
        expect(computeRateLimiterRetryAfterMs(limiter, Date.now())).toBe(1251);
        expect(limiter.allow()).toBe(false);
        now = 2_250;
        expect(computeRateLimiterRetryAfterMs(limiter, Date.now())).toBe(1);
        expect(limiter.allow()).toBe(false);
        now = 2_251;
        expect(computeRateLimiterRetryAfterMs(limiter, Date.now())).toBe(0);
        expect(limiter.allow()).toBe(true);
    });

    it('selects the first eligible staggered bucket rather than waiting for every overlapping bucket', () => {
        let now = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        onTestFinished(() => {
            vi.restoreAllMocks();
        });
        const limiter = RateLimiter.init(400, 2);
        expect(limiter.allow()).toBe(true);
        now = 1_150;
        expect(limiter.allow()).toBe(true);
        expect(computeRateLimiterRetryAfterMs(limiter, Date.now())).toBe(351);
        now = 1_250;
        expect(computeRateLimiterRetryAfterMs(limiter, Date.now())).toBe(251);
        expect(limiter.allow()).toBe(false);
        now = 1_500;
        expect(computeRateLimiterRetryAfterMs(limiter, Date.now())).toBe(1);
        expect(limiter.allow()).toBe(false);
        now = 1_501;
        expect(computeRateLimiterRetryAfterMs(limiter, Date.now())).toBe(0);
        expect(limiter.allow()).toBe(true);
        expect(computeRateLimiterRetryAfterMs(limiter, Date.now())).toBe(0);
    });

    it('measures relative delay from a backward Date clock without changing creation-time clamping', () => {
        let now = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        onTestFinished(() => {
            vi.restoreAllMocks();
        });
        const limiter = RateLimiter.init(100, 1);
        expect(limiter.allow()).toBe(true);
        now = 900;
        expect(computeRateLimiterRetryAfterMs(limiter, Date.now())).toBe(226);
        expect(limiter.allow()).toBe(false);
        now = 1_125;
        expect(computeRateLimiterRetryAfterMs(limiter, Date.now())).toBe(1);
        expect(limiter.allow()).toBe(false);
        now = 1_126;
        expect(limiter.allow()).toBe(true);
    });

    it.each([0, -1])('returns no invented wake for a policy that never allows (%s)', (maximum) => {
        vi.spyOn(Date, 'now').mockReturnValue(1_000);
        onTestFinished(() => {
            vi.restoreAllMocks();
        });
        const limiter = RateLimiter.init(100, maximum);
        expect(computeRateLimiterRetryAfterMs(limiter, Date.now())).toBeUndefined();
        expect(limiter.allow()).toBe(false);
    });
});
