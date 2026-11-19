import { describe, expect, it } from 'vitest';

import type { TopologyReshapeGateState } from '@shared/api/topology-plan/topology-reshape-gate.ts';

import { resolveTopologyReshapeDue } from '@shared-server/rallar-system/topology/planning/reshape-gate/resolve-topology-reshape-due.ts';
import { BACKOFF_GATE_TEST_BOUNDS } from '../../../../../shared/resilience/backoff-gate-test-fixtures.ts';

const HELD_STATE: TopologyReshapeGateState = {
    gate: { lastPassAtEpochMs: 100_000, consecutiveHeldPasses: 0, heldAtEpochMs: 103_000 },
    wantedReasons: ['kind-change']
};

describe('resolveTopologyReshapeDue', () => {
    it('is due once the gate of the period it was queued under opens with a reshape still wanted', () => {
        expect(resolveTopologyReshapeDue({
            state: HELD_STATE,
            bounds: BACKOFF_GATE_TEST_BOUNDS,
            nowEpochMs: 115_000,
            periodStartedAtEpochMs: 100_000
        })).toEqual({ decision: 'due' });
    });

    it('is not due while the gate is still closed, and says how long until it opens', () => {
        expect(resolveTopologyReshapeDue({
            state: HELD_STATE,
            bounds: BACKOFF_GATE_TEST_BOUNDS,
            nowEpochMs: 114_000,
            periodStartedAtEpochMs: 100_000
        })).toEqual({ decision: 'not-due', retryAfterMs: 1_000 });
    });

    it('is settled when a later reshape started another period', () => {
        expect(resolveTopologyReshapeDue({
            state: { ...HELD_STATE, gate: { lastPassAtEpochMs: 110_000, consecutiveHeldPasses: 1, heldAtEpochMs: null } },
            bounds: BACKOFF_GATE_TEST_BOUNDS,
            nowEpochMs: 115_000,
            periodStartedAtEpochMs: 100_000
        })).toEqual({ decision: 'settled' });
    });

    it('is settled when nothing is wanted any more, even with the gate closed', () => {
        expect(resolveTopologyReshapeDue({
            state: { ...HELD_STATE, wantedReasons: [] },
            bounds: BACKOFF_GATE_TEST_BOUNDS,
            nowEpochMs: 114_000,
            periodStartedAtEpochMs: 100_000
        })).toEqual({ decision: 'settled' });
    });

    it('is settled when the room holds no gate', () => {
        expect(resolveTopologyReshapeDue({
            state: null,
            bounds: BACKOFF_GATE_TEST_BOUNDS,
            nowEpochMs: 115_000,
            periodStartedAtEpochMs: 100_000
        })).toEqual({ decision: 'settled' });
    });
});
