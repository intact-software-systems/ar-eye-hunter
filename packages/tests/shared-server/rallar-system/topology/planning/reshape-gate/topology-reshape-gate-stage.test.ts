import { describe, expect, it } from 'vitest';

import type { GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { TopologyReshapeGateState } from '@shared/api/topology-plan/topology-reshape-gate.ts';

import {
    computeStagedTopologyReshapeGate,
    resolveStagedTopologyReshapeDue,
    resolveStagedTopologyReshapePermission,
    type TopologyReshapeGateStage
} from '@shared-server/rallar-system/topology/planning/reshape-gate/topology-reshape-gate-stage.ts';

const HELD_STATE: TopologyReshapeGateState = {
    gate: { lastPassAtEpochMs: 100_000, consecutiveHeldPasses: 1, heldAtEpochMs: 103_000 },
    wantedReasons: ['kind-change']
};

/** The held state at an instant its 30 s gate is still closed. */
function toStage(lifecycleState: GroupLifecycleState): TopologyReshapeGateStage {
    return {
        lifecycleState,
        state: HELD_STATE,
        bounds: { minIntervalMs: 15_000, maxIntervalMs: 60_000 },
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
