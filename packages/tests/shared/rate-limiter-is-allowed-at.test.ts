import { RateLimiter } from '@shared/resilience/Resilience.ts';
import { describe, expect, it } from 'vitest';

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
