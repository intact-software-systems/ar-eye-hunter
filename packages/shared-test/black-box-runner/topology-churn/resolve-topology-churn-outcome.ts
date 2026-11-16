import type { AdminRoomTopologyPlan } from '@shared/api/admin-rooms/admin-room-topology-plans.ts';
import {
    isSameGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { RallarRtcTopologyKind } from '@shared/api/overlay-topology.ts';

import { toPlannedTopologyPlans } from './to-planned-topology-plans.ts';

export interface ResolveTopologyChurnOutcomeInput {
    readonly plans: readonly AdminRoomTopologyPlan[];
    readonly acceptedLayout: GroupLayoutIdentity | null;
}

export interface TopologyChurnOutcome {
    readonly converged: boolean;
    readonly topology: readonly RallarRtcTopologyKind[];
}

export function resolveTopologyChurnOutcome(input: ResolveTopologyChurnOutcomeInput): TopologyChurnOutcome {
    const planned = toPlannedTopologyPlans(input.plans);
    const newest = planned.at(-1);
    return {
        converged: newest !== undefined && input.acceptedLayout !== null &&
            isSameGroupLayoutIdentity(newest.layout, input.acceptedLayout),
        topology: [...new Set(planned.map((entry) => entry.topology))]
    };
}
