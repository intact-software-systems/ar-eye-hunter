import { toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import {
    TOPOLOGY_REPLAN_CAUSES,
    type RtcTopologyPlanRecord,
    type TopologyLayoutDelta,
    type TopologyReplanCause
} from '@shared/api/topology-plan/rtc-topology-plan-record.ts';

import { computeLongestHopPath } from './compute-longest-hop-path.ts';
import { computeTopologyLayoutDelta } from './compute-topology-layout-delta.ts';

export interface ComputeRtcTopologyPlanRecordInput {
    readonly stored: RallarOverlayTopologySnapshot | null;
    readonly planned: RallarOverlayTopologySnapshot;
    readonly rttRefresh: boolean;
    readonly changeGated: boolean;
    readonly leaderRerooted: boolean;
    readonly nowEpochMs: number;
}

interface ResolveTopologyReplanCausesInput {
    readonly delta: TopologyLayoutDelta;
    readonly replaced: RallarOverlayTopologySnapshot | null;
    readonly planned: RallarOverlayTopologySnapshot;
    readonly rttRefresh: boolean;
    readonly changeGated: boolean;
    readonly leaderRerooted: boolean;
}

export function computeRtcTopologyPlanRecord(input: ComputeRtcTopologyPlanRecordInput): RtcTopologyPlanRecord {
    const { stored, planned, nowEpochMs } = input;
    const replaced = stored?.state === 'active' ? stored : null;
    const delta = computeTopologyLayoutDelta(replaced, planned);
    return {
        plannedAtEpochMs: nowEpochMs,
        replaced: replaced === null ? null : {
            layout: toGroupLayoutIdentity(replaced),
            ageMs: Math.max(0, nowEpochMs - replaced.updatedAtEpochMs)
        },
        causes: resolveTopologyReplanCauses({
            delta,
            replaced,
            planned,
            rttRefresh: input.rttRefresh,
            changeGated: input.changeGated,
            leaderRerooted: input.leaderRerooted
        }),
        delta,
        longestPathHops: computeLongestHopPath(planned)
    };
}

function resolveTopologyReplanCauses(input: ResolveTopologyReplanCausesInput): readonly TopologyReplanCause[] {
    const { delta, replaced, planned } = input;
    const configChanged = replaced !== null &&
        (replaced.degreeLimit !== planned.degreeLimit || replaced.name !== planned.name);
    const present: Readonly<Record<TopologyReplanCause, boolean>> = {
        join: delta.joinedSessionCount > 0,
        leave: delta.leftSessionCount > 0,
        'leader-change': input.leaderRerooted,
        config: (!input.rttRefresh && !input.changeGated) || configChanged,
        rtt: input.rttRefresh
    };
    return TOPOLOGY_REPLAN_CAUSES.filter((cause) => present[cause]);
}
