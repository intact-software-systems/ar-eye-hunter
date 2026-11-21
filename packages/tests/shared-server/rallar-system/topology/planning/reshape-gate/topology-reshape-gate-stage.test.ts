import { describe, expect, it } from 'vitest';

import type { GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { TopologyReshapeGateState } from '@shared/api/topology-plan/topology-reshape-gate.ts';

import {
    computeStagedHeldTopologyReshape,
    computeStagedTopologyReshapeGate,
    resolveStagedTopologyReshapeDue,
    resolveStagedTopologyReshapePermission,
    type TopologyReshapeGateStage
} from '@shared-server/rallar-system/topology/planning/reshape-gate/topology-reshape-gate-stage.ts';
import { BACKOFF_GATE_TEST_BOUNDS, toBackoffGateState } from '../../../../../shared/resilience/backoff-gate-test-fixtures.ts';

const HELD_STATE: TopologyReshapeGateState = {
    gate: { lastPassAtEpochMs: 100_000, consecutiveHeldPasses: 1, heldAtEpochMs: 103_000 },
    wantedReasons: ['kind-change']
};

/** The held state at an instant its 30 s gate is still closed. */
function toStage(lifecycleState: GroupLifecycleState): TopologyReshapeGateStage {
    return {
        lifecycleState,
        state: HELD_STATE,
        bounds: BACKOFF_GATE_TEST_BOUNDS,
        nowEpochMs: 110_000
    };
}

describe('the reshape gate in the room\'s stage', () => {
    it('applies in the stage that follows the replanning policy', () => {
        const active = toStage('active');

        expect(resolveStagedTopologyReshapePermission(active, 'automatic')).toEqual({ reshape: 'held' });
        expect(resolveStagedTopologyReshapeDue(active, 100_000)).toEqual({ decision: 'not-due', retryAfterMs: 20_000 });
        expect(computeStagedTopologyReshapeGate(active, { kind: 'reshape' })).toMatchObject({ decision: 'write' });
    });

    it.each(['planned', 'reconfiguring', 'connecting', 'reconnecting'] as const)(
        'is neither consulted nor advanced in %s',
        (lifecycleState) => {
            const stage = toStage(lifecycleState);

            expect(resolveStagedTopologyReshapePermission(stage, 'automatic'))
                .toEqual({ reshape: 'allowed', wantedReasons: [] });
            expect(resolveStagedTopologyReshapeDue(stage, 100_000)).toEqual({ decision: 'due' });
            expect(computeStagedTopologyReshapeGate(stage, { kind: 'reshape' })).toEqual({ decision: 'unchanged' });
            expect(computeStagedTopologyReshapeGate(stage, { kind: 'kept', heldReasons: [] }))
                .toEqual({ decision: 'unchanged' });
        }
    );

    it('a first layout resets a used gate in a stage the gate does not apply in', () => {
        expect(computeStagedTopologyReshapeGate(toStage('planned'), { kind: 'established' })).toEqual({
            decision: 'write',
            state: { gate: { lastPassAtEpochMs: null, consecutiveHeldPasses: 0, heldAtEpochMs: null }, wantedReasons: [] },
            wakeUpDueAtEpochMs: null
        });
    });
});

describe('the held reshape a formation read states', () => {
    it('states the stored reasons and the instant the gate opens where the gate applies', () => {
        expect(computeStagedHeldTopologyReshape(toStage('active')))
            .toEqual({ wantedReasons: ['kind-change'], opensAtEpochMs: 130_000 });
    });

    it('has no clock, so a gate that opened long ago is still stated with its instant in the past', () => {
        const longAfter: TopologyReshapeGateStage = { ...toStage('active'), nowEpochMs: 9_999_999 };

        expect(computeStagedHeldTopologyReshape(longAfter))
            .toEqual({ wantedReasons: ['kind-change'], opensAtEpochMs: 130_000 });
    });

    it('keeps both reasons in their stored order and stops doubling at the upper bound', () => {
        const state: TopologyReshapeGateState = {
            gate: toBackoffGateState(100_000, 5, 101_000),
            wantedReasons: ['kind-change', 'leader-rooting']
        };

        expect(computeStagedHeldTopologyReshape({ ...toStage('active'), state }))
            .toEqual({ wantedReasons: ['kind-change', 'leader-rooting'], opensAtEpochMs: 160_000 });
    });

    it('computes the opening from the bounds it is given', () => {
        const state: TopologyReshapeGateState = { gate: toBackoffGateState(100_000, 0, 104_000), wantedReasons: ['leader-rooting'] };
        const bounds = { minIntervalMs: 20_000, maxIntervalMs: 40_000 };

        expect(computeStagedHeldTopologyReshape({ lifecycleState: 'active', state, bounds }))
            .toEqual({ wantedReasons: ['leader-rooting'], opensAtEpochMs: 120_000 });
    });

    it.each(['dormant', 'forming', 'planned', 'connecting', 'reconfiguring', 'reconnecting'] as const)(
        'states none in %s, although reasons are still stored',
        (lifecycleState) => {
            expect(computeStagedHeldTopologyReshape(toStage(lifecycleState))).toBeNull();
        }
    );

    it('states none for a room that stores no gate', () => {
        expect(computeStagedHeldTopologyReshape({ ...toStage('active'), state: null })).toBeNull();
    });

    it('states none while a hold period runs with nothing wanted', () => {
        const state: TopologyReshapeGateState = { gate: toBackoffGateState(100_000, 1, 103_000), wantedReasons: [] };

        expect(computeStagedHeldTopologyReshape({ ...toStage('active'), state })).toBeNull();
    });

    // The gate's rule records a hold only against a pass, but the stored decoder accepts this record.
    it('states an open gate that still owes for wanted reasons on a gate that never passed', () => {
        const state: TopologyReshapeGateState = { gate: toBackoffGateState(null, 0, null), wantedReasons: ['kind-change'] };

        expect(computeStagedHeldTopologyReshape({ ...toStage('active'), state }))
            .toEqual({ wantedReasons: ['kind-change'], opensAtEpochMs: 0 });
    });
});
