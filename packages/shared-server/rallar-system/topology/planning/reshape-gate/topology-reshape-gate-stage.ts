import type { GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import {
    UNGATED_TOPOLOGY_RESHAPE_PERMISSION,
    type HeldTopologyReshape,
    type TopologyReshapeGateState,
    type TopologyReshapePermission
} from '@shared/api/topology-plan/topology-reshape-gate.ts';
import { computeBackoffGateOpensAt, type BackoffGateBounds } from '@shared/resilience/backoff-gate.ts';

import { consultsReplanningPolicy, type TopologyWorkOrigin } from '../resolve-topology-plan-action.ts';
import {
    computeTopologyReshapeGate,
    UNCHANGED_TOPOLOGY_RESHAPE_GATE,
    type ComputedTopologyReshapeGate,
    type TopologyReshapeGatePlanOutcome
} from './compute-topology-reshape-gate.ts';
import { resolveTopologyReshapeDue, type TopologyReshapeDue } from './resolve-topology-reshape-due.ts';
import { resolveTopologyReshapePermission } from './resolve-topology-reshape-permission.ts';

/**
 * The reshape gate as one work reads it in the room's stage. The gate spares browsers dials and overlap, so it applies
 * only while the stage follows the replanning policy. In any other stage nobody dials the planned layout: automatic
 * work plans ungated, and the gate is neither consulted nor advanced, except that a first layout still resets a used
 * gate so a room that forms again starts with an open gate.
 */
export interface TopologyReshapeGateStage {
    readonly lifecycleState: GroupLifecycleState;
    readonly state: TopologyReshapeGateState | null;
    readonly bounds: BackoffGateBounds;
    readonly nowEpochMs: number;
}

export function resolveStagedTopologyReshapePermission(
    stage: TopologyReshapeGateStage,
    workOrigin: TopologyWorkOrigin
): TopologyReshapePermission {
    return isTopologyReshapeGateApplied(stage)
        ? resolveTopologyReshapePermission({ ...stage, workOrigin })
        : UNGATED_TOPOLOGY_RESHAPE_PERMISSION;
}

/** Where the gate does not apply, a reshape-due row is planned as the stage's other automatic work is. */
export function resolveStagedTopologyReshapeDue(
    stage: TopologyReshapeGateStage,
    periodStartedAtEpochMs: number
): TopologyReshapeDue {
    return isTopologyReshapeGateApplied(stage)
        ? resolveTopologyReshapeDue({ ...stage, periodStartedAtEpochMs })
        : { decision: 'due' };
}

export function computeStagedTopologyReshapeGate(
    stage: TopologyReshapeGateStage,
    outcome: TopologyReshapeGatePlanOutcome
): ComputedTopologyReshapeGate {
    if (!isTopologyReshapeGateApplied(stage) && outcome.kind !== 'established') {
        return UNCHANGED_TOPOLOGY_RESHAPE_GATE;
    }
    return computeTopologyReshapeGate({
        previous: stage.state,
        bounds: stage.bounds,
        nowEpochMs: stage.nowEpochMs,
        outcome
    });
}

/** A gate that never passed is open, so it opens at epoch 0 while it still holds wanted reasons. */
export function computeStagedHeldTopologyReshape(
    stage: Pick<TopologyReshapeGateStage, 'lifecycleState' | 'state' | 'bounds'>
): HeldTopologyReshape | null {
    const { state } = stage;
    if (!isTopologyReshapeGateApplied(stage) || state === null || state.wantedReasons.length === 0) {
        return null;
    }
    return {
        wantedReasons: state.wantedReasons,
        opensAtEpochMs: computeBackoffGateOpensAt(state.gate, stage.bounds) ?? 0
    };
}

function isTopologyReshapeGateApplied(stage: Pick<TopologyReshapeGateStage, 'lifecycleState'>): boolean {
    return consultsReplanningPolicy(stage.lifecycleState);
}
