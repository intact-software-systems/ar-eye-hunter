import { describe, expect, it } from 'vitest';

import {
    computeBackoffGateHold,
    computeBackoffGateIntervalMs,
    computeBackoffGateOpensAt,
    computeBackoffGatePass,
    isBackoffGateOpen,
    type BackoffGateBounds,
    type BackoffGateState
} from '@shared/resilience/backoff-gate.ts';

const BOUNDS: BackoffGateBounds = { minIntervalMs: 15_000, maxIntervalMs: 60_000 };

function gate(lastPass: number | null, count: number, heldAt: number | null): BackoffGateState {
    return { lastPassAtEpochMs: lastPass, consecutiveHeldPasses: count, heldAtEpochMs: heldAt };
}

function pass(state: BackoffGateState | null, nowEpochMs: number): BackoffGateState {
    return computeBackoffGatePass({ state, bounds: BOUNDS, nowEpochMs });
}

describe('back-off gate', () => {
    it('a gate nothing has passed is open and its interval is the lower bound', () => {
        expect(isBackoffGateOpen(null, BOUNDS, 0)).toBe(true);
        expect(computeBackoffGateOpensAt(null, BOUNDS)).toBeNull();
        expect(computeBackoffGateIntervalMs(null, BOUNDS)).toBe(15_000);
    });

    it('the first pass starts a period at the lower bound', () => {
        expect(pass(null, 1_000)).toEqual(gate(1_000, 0, null));
    });

    it('the gate is closed until its interval has passed and open from that instant', () => {
        const state = gate(0, 0, null);

        expect(computeBackoffGateOpensAt(state, BOUNDS)).toBe(15_000);
        expect(isBackoffGateOpen(state, BOUNDS, 14_999)).toBe(false);
        expect(isBackoffGateOpen(state, BOUNDS, 15_000)).toBe(true);
    });

    it('a hold records its first instant only', () => {
        const once = computeBackoffGateHold(gate(0, 0, null), 3_000);
        const twice = computeBackoffGateHold(once, 6_000);

        expect(once).toEqual(gate(0, 0, 3_000));
        expect(twice).toEqual(gate(0, 0, 3_000));
    });

    it('a pass after a hold doubles the interval up to the upper bound', () => {
        const first = pass(gate(0, 0, 3_000), 15_000);
        expect(first).toEqual(gate(15_000, 1, null));
        expect(computeBackoffGateIntervalMs(first, BOUNDS)).toBe(30_000);

        const second = pass(computeBackoffGateHold(first, 18_000), 45_000);
        expect(second).toEqual(gate(45_000, 2, null));
        expect(computeBackoffGateIntervalMs(second, BOUNDS)).toBe(60_000);

        const third = pass(computeBackoffGateHold(second, 48_000), 105_000);
        expect(third).toEqual(gate(105_000, 2, null));
        expect(computeBackoffGateIntervalMs(third, BOUNDS)).toBe(60_000);
    });

    it('a held pass that comes after twice the interval starts over', () => {
        expect(pass(gate(0, 1, 3_000), 600_000)).toEqual(gate(600_000, 0, null));
    });

    it('a pass through an open gate with nothing held starts over', () => {
        expect(pass(gate(0, 2, null), 60_000)).toEqual(gate(60_000, 0, null));
    });

    it('a pass through a closed gate with nothing held keeps the count', () => {
        expect(pass(gate(0, 2, null), 5_000)).toEqual(gate(5_000, 2, null));
    });

    it('bounds that change apply to the interval at once', () => {
        const narrowed: BackoffGateBounds = { minIntervalMs: 15_000, maxIntervalMs: 30_000 };

        expect(computeBackoffGateOpensAt(gate(0, 2, null), BOUNDS)).toBe(60_000);
        expect(computeBackoffGateOpensAt(gate(0, 2, null), narrowed)).toBe(30_000);
    });
});
