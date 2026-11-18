import {
    UNGATED_TOPOLOGY_RESHAPE_PERMISSION,
    type TopologyReshapeGateState,
    type TopologyReshapePermission
} from '@shared/api/topology-plan/topology-reshape-gate.ts';
import { isBackoffGateOpen, type BackoffGateBounds } from '@shared/resilience/backoff-gate.ts';

import type { TopologyWorkOrigin } from '../resolve-topology-plan-action.ts';

export interface ResolveTopologyReshapePermissionInput {
    readonly state: TopologyReshapeGateState | null;
    readonly bounds: BackoffGateBounds;
    readonly workOrigin: TopologyWorkOrigin;
    readonly nowEpochMs: number;
}

export function resolveTopologyReshapePermission(
    input: ResolveTopologyReshapePermissionInput
): TopologyReshapePermission {
    if (input.workOrigin === 'commanded') {
        return UNGATED_TOPOLOGY_RESHAPE_PERMISSION;
    }
    if (!isBackoffGateOpen(input.state?.gate ?? null, input.bounds, input.nowEpochMs)) {
        return { reshape: 'held' };
    }
    return { reshape: 'allowed', wantedReasons: input.state?.wantedReasons ?? [] };
}
