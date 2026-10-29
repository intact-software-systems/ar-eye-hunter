import { computeNextCadenceAtMs, isCadenceDue } from '@shared/resilience/cadence.ts';
import { describe, expect, it } from 'vitest';

const CADENCE_MS = 100;

describe('computeNextCadenceAtMs', () => {
    it('is now when there was no last', () => {
        expect(computeNextCadenceAtMs({ lastAtMs: undefined, cadenceMs: CADENCE_MS, nowMs: 5_000 })).toBe(5_000);
    });

    it('is one cadence after the last while that boundary is not behind now', () => {
        expect(computeNextCadenceAtMs({ lastAtMs: 5_000, cadenceMs: CADENCE_MS, nowMs: 5_000 })).toBe(5_100);
        expect(computeNextCadenceAtMs({ lastAtMs: 5_000, cadenceMs: CADENCE_MS, nowMs: 5_099 })).toBe(5_100);
        expect(computeNextCadenceAtMs({ lastAtMs: 5_000, cadenceMs: CADENCE_MS, nowMs: 5_100 })).toBe(5_100);
    });

    it('is now, not a catch-up burst, when the boundary passed ten cadences ago', () => {
        const lateNowMs = 5_000 + 10 * CADENCE_MS;
        const nextAtMs = computeNextCadenceAtMs({ lastAtMs: 5_000, cadenceMs: CADENCE_MS, nowMs: lateNowMs });

        expect(nextAtMs).toBe(lateNowMs);
        expect(computeNextCadenceAtMs({ lastAtMs: nextAtMs, cadenceMs: CADENCE_MS, nowMs: lateNowMs }))
            .toBe(lateNowMs + CADENCE_MS);
    });

    it('is now for a zero cadence', () => {
        expect(computeNextCadenceAtMs({ lastAtMs: 5_000, cadenceMs: 0, nowMs: 5_000 })).toBe(5_000);
    });
});

describe('isCadenceDue', () => {
    it('is always due for a zero or negative cadence', () => {
        expect(isCadenceDue({ lastAtMs: 5_000, cadenceMs: 0, nowMs: 5_000 })).toBe(true);
        expect(isCadenceDue({ lastAtMs: 5_000, cadenceMs: -10, nowMs: 5_000 })).toBe(true);
    });

    it('is due when there was no last', () => {
        expect(isCadenceDue({ lastAtMs: undefined, cadenceMs: CADENCE_MS, nowMs: 5_000 })).toBe(true);
    });

    it('is due from the boundary on and not before it', () => {
        expect(isCadenceDue({ lastAtMs: 5_000, cadenceMs: CADENCE_MS, nowMs: 5_099 })).toBe(false);
        expect(isCadenceDue({ lastAtMs: 5_000, cadenceMs: CADENCE_MS, nowMs: 5_100 })).toBe(true);
        expect(isCadenceDue({ lastAtMs: 5_000, cadenceMs: CADENCE_MS, nowMs: 6_000 })).toBe(true);
    });
});
