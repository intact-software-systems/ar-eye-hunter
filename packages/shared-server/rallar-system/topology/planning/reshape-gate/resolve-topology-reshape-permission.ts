import type {
    TopologyReshapeGateState,
    TopologyReshapePermission
} from '@shared/api/topology-plan/topology-reshape-gate.ts';
import { isBackoffGateOpen, type BackoffGateBounds } from '@shared/resilience/backoff-gate.ts';

import type { TopologyWorkOrigin } from '../resolve-topology-plan-action.ts';

export interface ResolveTopologyReshapePermissionInput {
    readonly state: TopologyReshapeGateState | null;
    readonly bounds: BackoffGateBounds;
    readonly workOrigin: TopologyWorkOrigin;
    readonly nowEpochMs: number;
}

/** Commanded work passes a closed gate with the reasons still wanted, so the planner checks them as for automatic work. */
export function resolveTopologyReshapePermission(
    input: ResolveTopologyReshapePermissionInput
): TopologyReshapePermission {
    if (
        input.workOrigin === 'automatic' &&
        !isBackoffGateOpen(input.state?.gate ?? null, input.bounds, input.nowEpochMs)
    ) {
        return { reshape: 'held' };
    }
    return { reshape: 'allowed', wantedReasons: input.state?.wantedReasons ?? [] };
}
