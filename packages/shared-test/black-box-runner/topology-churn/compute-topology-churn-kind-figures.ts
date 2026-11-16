import type { RtcTopologyPlanRecord } from '@shared/api/topology-plan/rtc-topology-plan-record.ts';
import {
    TOPOLOGY_RESHAPE_REASONS,
    type TopologyPlanChange,
    type TopologyReshapeReason
} from '@shared/api/topology-plan/topology-plan-change.ts';

import { computeCountsByKey } from './compute-counts-by-key.ts';

interface TopologyChurnKindCounts {
    readonly attach: number;
    readonly repair: number;
    readonly reshape: number;
}

export interface TopologyChurnKindFigures {
    readonly plansByKind: TopologyChurnKindCounts;
    readonly promotedPlansByKind: TopologyChurnKindCounts;
    readonly reroutingPlansByKind: TopologyChurnKindCounts;
    readonly reshapesByReason: Readonly<Record<TopologyReshapeReason, number>>;
}

interface ComputeTopologyChurnKindFiguresInput {
    readonly records: readonly RtcTopologyPlanRecord[];
    readonly promotedRecords: readonly RtcTopologyPlanRecord[];
}

export function computeTopologyChurnKindFigures(input: ComputeTopologyChurnKindFiguresInput): TopologyChurnKindFigures {
    return {
        plansByKind: computeKindCounts(input.records),
        promotedPlansByKind: computeKindCounts(input.promotedRecords),
        reroutingPlansByKind: computeKindCounts(
            input.records.filter((record) => record.delta.reroutedSessionCount > 0)
        ),
        reshapesByReason: computeCountsByKey(
            TOPOLOGY_RESHAPE_REASONS,
            (reason) =>
                input.records.filter((record) => record.change?.kind === 'reshape' && record.change.reason === reason)
                    .length
        )
    };
}

/** A record with no change (an identity-only plan) belongs to no kind. */
function computeKindCounts(records: readonly RtcTopologyPlanRecord[]): TopologyChurnKindCounts {
    const countKind = (kind: TopologyPlanChange['kind']): number =>
        records.filter((record) => record.change?.kind === kind).length;
    return { attach: countKind('attach'), repair: countKind('repair'), reshape: countKind('reshape') };
}
