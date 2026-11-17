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
    /** Accepted minus fresh; negative when the accepted layout is shorter than the fresh plan. */
    readonly hopDifference: number;
}

/**
 * The signed difference between the accepted layout's longest path and a fresh no-RTT plan's for the same members,
 * kind, degree limit and leader, planned as the planner plans one: a tree from the leader, a star without a preferred
 * source, a mesh without one and with the room's mesh parameter. The fresh plan is the planner's reference layout,
 * not the shortest one, so an evolved layout can be shorter.
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
    return {
        acceptedLongestPathHops,
        freshLongestPathHops,
        hopDifference: acceptedLongestPathHops - freshLongestPathHops
    };
}
