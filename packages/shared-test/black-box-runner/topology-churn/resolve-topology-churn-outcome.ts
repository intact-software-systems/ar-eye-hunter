import type { AdminRoomTopologyPlan } from '@shared/api/admin-rooms/admin-room-topology-plans.ts';
import {
    isSameGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { RallarRtcTopologyKind } from '@shared/api/overlay-topology.ts';

export interface ResolveTopologyChurnOutcomeInput {
    readonly plans: readonly AdminRoomTopologyPlan[];
    readonly acceptedLayout: GroupLayoutIdentity | null;
}

export interface TopologyChurnOutcome {
    /** The newest planned record's layout is the accepted layout. */
    readonly converged: boolean;
    /** Each kind the planned records used, once, in planned order. */
    readonly topology: readonly RallarRtcTopologyKind[];
}

export function resolveTopologyChurnOutcome(input: ResolveTopologyChurnOutcomeInput): TopologyChurnOutcome {
    const planned = input.plans
        .flatMap((entry) => entry.plan === null ? [] : [{ entry, plannedAtEpochMs: entry.plan.plannedAtEpochMs }])
        .sort((left, right) => left.plannedAtEpochMs - right.plannedAtEpochMs)
        .map(({ entry }) => entry);
    const newest = planned.at(-1);
    return {
        converged: newest !== undefined && input.acceptedLayout !== null &&
            isSameGroupLayoutIdentity(newest.layout, input.acceptedLayout),
        topology: [...new Set(planned.map((entry) => entry.topology))]
    };
}
