import { computeNoRttTopologyNextHops } from '@shared-server/rallar-system/topology/planning/compute-no-rtt-topology-next-hops.ts';
import { computeLongestHopPath } from '@shared-server/rallar-system/topology/planning/plan-record/compute-longest-hop-path.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

export interface ComputeTopologyChurnDriftInput {
    readonly layout: Pick<
        RallarOverlayTopologySnapshot,
        'topology' | 'activeSessionIds' | 'nextHopsBySessionId' | 'degreeLimit'
    >;
    readonly leaderSessionId: string | undefined;
}

export type TopologyChurnDrift =
    | {
        readonly status: 'measured';
        readonly acceptedLongestPathHops: number;
        readonly freshLongestPathHops: number;
        readonly extraHops: number;
    }
    | { readonly status: 'undetermined'; readonly reason: string; };

const MESH_DRIFT_REASON = 'A fresh mesh plan needs the room\'s mesh parameter, which no typed read serves.';
/** `computeNoRttTopologyNextHops` reads the mesh parameter only for a mesh. */
const MESH_PARAMETER_UNREAD_FOR_STAR_AND_TREE = 0;

/**
 * How many hops the accepted layout's longest path exceeds a fresh no-RTT plan's for the same members, kind, degree
 * limit and leader, planned as the planner plans one: a star without a preferred source, a tree from the leader.
 */
export function computeTopologyChurnDrift(input: ComputeTopologyChurnDriftInput): TopologyChurnDrift {
    const { layout } = input;
    if (layout.topology === 'mesh') {
        return { status: 'undetermined', reason: MESH_DRIFT_REASON };
    }
    const fresh = computeNoRttTopologyNextHops({
        topology: layout.topology,
        activeSessionIds: layout.activeSessionIds,
        preferredSourceSessionId: layout.topology === 'tree' ? input.leaderSessionId : undefined,
        degreeLimit: layout.degreeLimit,
        meshParamK: MESH_PARAMETER_UNREAD_FOR_STAR_AND_TREE
    });
    const acceptedLongestPathHops = computeLongestHopPath(layout);
    const freshLongestPathHops = computeLongestHopPath({
        activeSessionIds: layout.activeSessionIds,
        nextHopsBySessionId: fresh
    });
    return {
        status: 'measured',
        acceptedLongestPathHops,
        freshLongestPathHops,
        extraHops: acceptedLongestPathHops - freshLongestPathHops
    };
}
