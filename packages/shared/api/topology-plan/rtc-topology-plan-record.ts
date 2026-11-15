import type { GroupLayoutIdentity } from '../group-lifecycle/group-layout-identity.ts';

export const TOPOLOGY_REPLAN_CAUSES = ['join', 'leave', 'leader-change', 'config', 'rtt'] as const;

export type TopologyReplanCause = (typeof TOPOLOGY_REPLAN_CAUSES)[number];

export interface TopologyLayoutDelta {
    readonly joinedSessionCount: number;
    readonly leftSessionCount: number;
    readonly changedSessionCount: number;
    readonly reroutedSessionCount: number;
    readonly acceptingSessionCount: number;
    readonly maxJoinerEdgesPerSession: number;
}

export interface ReplacedTopologyLayout {
    readonly layout: GroupLayoutIdentity;
    readonly ageMs: number;
}

/** `replaced` is null when no active layout stood before the plan: that absence is the fact "first layout". */
export interface RtcTopologyPlanRecord {
    readonly plannedAtEpochMs: number;
    readonly replaced: ReplacedTopologyLayout | null;
    readonly causes: readonly TopologyReplanCause[];
    readonly delta: TopologyLayoutDelta;
    readonly longestPathHops: number;
}
