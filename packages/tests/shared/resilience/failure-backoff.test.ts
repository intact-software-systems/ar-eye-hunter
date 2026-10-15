import { describe, expect, it } from 'vitest';

import { FailureBackoff } from '@shared/resilience/failure-backoff.ts';

describe('failure backoff', () => {
    it('doubles the delay from the base on each consecutive failure up to the cap', () => {
        const backoff = new FailureBackoff({ baseMs: 100, maxMs: 400 });

        expect(backoff.recordFailure(1_000)).toBe(1_100);
        expect(backoff.recordFailure(1_100)).toBe(1_300);
        expect(backoff.recordFailure(1_300)).toBe(1_700);
        expect(backoff.recordFailure(1_700)).toBe(2_100);
        expect(backoff.recordFailure(2_100)).toBe(2_500);
        expect(backoff.getConsecutiveFailures()).toBe(5);
    });

    it('answers the retry instant only while it lies ahead of now', () => {
        const backoff = new FailureBackoff({ baseMs: 100, maxMs: 400 });
        expect(backoff.getRetryAtMs(1_000)).toBeUndefined();

        backoff.recordFailure(1_000);

        expect(backoff.getRetryAtMs(1_050)).toBe(1_100);
        expect(backoff.getRetryAtMs(1_099)).toBe(1_100);
        expect(backoff.getRetryAtMs(1_100)).toBeUndefined();
        expect(backoff.getRetryAtMs(5_000)).toBeUndefined();
    });

    it('starts over from the base after a success', () => {
        const backoff = new FailureBackoff({ baseMs: 100, maxMs: 400 });
        backoff.recordFailure(1_000);
        backoff.recordFailure(1_100);
        backoff.recordFailure(1_300);

        backoff.recordSuccess();

        expect(backoff.getConsecutiveFailures()).toBe(0);
        expect(backoff.getRetryAtMs(0)).toBeUndefined();
        expect(backoff.recordFailure(2_000)).toBe(2_100);
    });

    it('caps the delay at the maximum even when the base is above it', () => {
        const backoff = new FailureBackoff({ baseMs: 30_000, maxMs: 20_000 });

        expect(backoff.recordFailure(0)).toBe(20_000);
        expect(backoff.recordFailure(20_000)).toBe(40_000);
    });

    it('rejects a base or maximum that is not a positive finite number', () => {
        expect(() => new FailureBackoff({ baseMs: 0, maxMs: 100 })).toThrow(TypeError);
        expect(() => new FailureBackoff({ baseMs: 100, maxMs: Number.NaN })).toThrow(TypeError);
        expect(() => new FailureBackoff({ baseMs: -1, maxMs: 100 })).toThrow(TypeError);
    });
});
