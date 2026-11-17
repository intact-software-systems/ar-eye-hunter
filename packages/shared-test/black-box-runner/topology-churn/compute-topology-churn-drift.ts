import { computeNoRttTopologyNextHops } from '@shared-server/rallar-system/topology/planning/compute-no-rtt-topology-next-hops.ts';
import { computeLongestHopPath } from '@shared-server/rallar-system/topology/planning/plan-record/compute-longest-hop-path.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

interface ComputeTopologyChurnDriftInput {
    readonly layout: Pick<
        RallarOverlayTopologySnapshot,
        'topology' | 'activeSessionIds' | 'nextHopsBySessionId' | 'degreeLimit'
    >;
    readonly leaderSessionId: string | undefined;
    readonly meshParamK: number;
}

export interface TopologyChurnDrift {
    readonly acceptedLongestPathHops: number;
    readonly freshLongestPathHops: number;
    readonly extraHops: number;
}

/**
 * How many hops the accepted layout's longest path exceeds a fresh no-RTT plan's for the same members, kind, degree
 * limit and leader, planned as the planner plans one: a tree from the leader, a star and a mesh without a preferred
 * source, a mesh with the room's mesh parameter.
 */
export function computeTopologyChurnDrift(input: ComputeTopologyChurnDriftInput): TopologyChurnDrift {
    const { layout } = input;
    const fresh = computeNoRttTopologyNextHops({
        topology: layout.topology,
        activeSessionIds: layout.activeSessionIds,
        preferredSourceSessionId: layout.topology === 'tree' ? input.leaderSessionId : undefined,
        degreeLimit: layout.degreeLimit,
        meshParamK: input.meshParamK
    });
    const acceptedLongestPathHops = computeLongestHopPath(layout);
    const freshLongestPathHops = computeLongestHopPath({
        activeSessionIds: layout.activeSessionIds,
        nextHopsBySessionId: fresh
    });
    return { acceptedLongestPathHops, freshLongestPathHops, extraHops: acceptedLongestPathHops - freshLongestPathHops };
}
