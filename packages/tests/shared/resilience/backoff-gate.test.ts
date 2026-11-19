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
import { BACKOFF_GATE_TEST_BOUNDS, toBackoffGateState } from './backoff-gate-test-fixtures.ts';

function pass(state: BackoffGateState | null, nowEpochMs: number): BackoffGateState {
    return computeBackoffGatePass({ state, bounds: BACKOFF_GATE_TEST_BOUNDS, nowEpochMs });
}

describe('back-off gate', () => {
    it('a gate nothing has passed is open and its interval is the lower bound', () => {
        expect(isBackoffGateOpen(null, BACKOFF_GATE_TEST_BOUNDS, 0)).toBe(true);
        expect(computeBackoffGateOpensAt(null, BACKOFF_GATE_TEST_BOUNDS)).toBeNull();
        expect(computeBackoffGateIntervalMs(null, BACKOFF_GATE_TEST_BOUNDS)).toBe(15_000);
    });

    it('the first pass starts a period at the lower bound', () => {
        expect(pass(null, 1_000)).toEqual(toBackoffGateState(1_000, 0, null));
    });

    it('the gate is closed until its interval has passed and open from that instant', () => {
        const state = toBackoffGateState(0, 0, null);

        expect(computeBackoffGateOpensAt(state, BACKOFF_GATE_TEST_BOUNDS)).toBe(15_000);
        expect(isBackoffGateOpen(state, BACKOFF_GATE_TEST_BOUNDS, 14_999)).toBe(false);
        expect(isBackoffGateOpen(state, BACKOFF_GATE_TEST_BOUNDS, 15_000)).toBe(true);
    });

    it('a hold records its first instant only', () => {
        const once = computeBackoffGateHold(toBackoffGateState(0, 0, null), 3_000);
        const twice = computeBackoffGateHold(once, 6_000);

        expect(once).toEqual(toBackoffGateState(0, 0, 3_000));
        expect(twice).toEqual(toBackoffGateState(0, 0, 3_000));
    });

    it('a pass after a hold doubles the interval up to the upper bound', () => {
        const first = pass(toBackoffGateState(0, 0, 3_000), 15_000);
        expect(first).toEqual(toBackoffGateState(15_000, 1, null));
        expect(computeBackoffGateIntervalMs(first, BACKOFF_GATE_TEST_BOUNDS)).toBe(30_000);

        const second = pass(computeBackoffGateHold(first, 18_000), 45_000);
        expect(second).toEqual(toBackoffGateState(45_000, 2, null));
        expect(computeBackoffGateIntervalMs(second, BACKOFF_GATE_TEST_BOUNDS)).toBe(60_000);

        const third = pass(computeBackoffGateHold(second, 48_000), 105_000);
        expect(third).toEqual(toBackoffGateState(105_000, 2, null));
        expect(computeBackoffGateIntervalMs(third, BACKOFF_GATE_TEST_BOUNDS)).toBe(60_000);
    });

    it('a held pass that comes after twice the interval starts over', () => {
        expect(pass(toBackoffGateState(0, 1, 3_000), 600_000)).toEqual(toBackoffGateState(600_000, 0, null));
    });

    it('a pass through an open gate with nothing held starts over', () => {
        expect(pass(toBackoffGateState(0, 2, null), 60_000)).toEqual(toBackoffGateState(60_000, 0, null));
    });

    it('a pass through a closed gate with nothing held keeps the count', () => {
        expect(pass(toBackoffGateState(0, 2, null), 5_000)).toEqual(toBackoffGateState(5_000, 2, null));
    });

    it('bounds that change apply to the interval at once', () => {
        const narrowed: BackoffGateBounds = { minIntervalMs: 15_000, maxIntervalMs: 30_000 };

        expect(computeBackoffGateOpensAt(toBackoffGateState(0, 2, null), BACKOFF_GATE_TEST_BOUNDS)).toBe(60_000);
        expect(computeBackoffGateOpensAt(toBackoffGateState(0, 2, null), narrowed)).toBe(30_000);
    });
});
