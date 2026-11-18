import { toGroupLayoutIdentity, type GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

export interface TopologyChurnLinkSample {
    readonly layout: GroupLayoutIdentity;
    readonly underLinkedMemberCount: number;
}

type TopologyChurnSampledLayout = Pick<
    RallarOverlayTopologySnapshot,
    'sourceGroupStateCausalRevision' | 'version' | 'state' | 'topology' | 'activeSessionIds' | 'nextHopsBySessionId'
>;

/** Null for a star or a tree: the mesh parameter promises a member its links only in a mesh. */
export function toTopologyChurnLinkSample(
    layout: TopologyChurnSampledLayout,
    meshParamK: number
): TopologyChurnLinkSample | null {
    if (layout.topology !== 'mesh') {
        return null;
    }
    return {
        layout: toGroupLayoutIdentity(layout),
        underLinkedMemberCount: layout.activeSessionIds.filter(
            (sessionId) => (layout.nextHopsBySessionId[sessionId] ?? []).length < meshParamK
        ).length
    };
}
