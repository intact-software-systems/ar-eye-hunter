import type { AdminRoomTopologyPlan } from '@shared/api/admin-rooms/admin-room-topology-plans.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { RallarRtcTopologyKind } from '@shared/api/overlay-topology.ts';
import { isEmptyTopologyLayoutDelta } from '@shared/api/topology-plan/is-empty-topology-layout-delta.ts';
import type {
    ReplacedTopologyLayout,
    TopologyLayoutDelta,
    TopologyReplanCause
} from '@shared/api/topology-plan/rtc-topology-plan-record.ts';
import type { TopologyPlanChange } from '@shared/api/topology-plan/topology-plan-change.ts';

import { EMPTY_TOPOLOGY_LAYOUT_DELTA } from '../../shared/api/topology-plan/empty-topology-layout-delta.ts';

export interface TopologyChurnTestPlanInput {
    readonly version: number;
    readonly plannedAtEpochMs: number;
    readonly topology?: RallarRtcTopologyKind;
    readonly replacedAgeMs?: number | null;
    readonly causes?: readonly TopologyReplanCause[];
    readonly delta?: Partial<TopologyLayoutDelta>;
    readonly change?: TopologyPlanChange;
    readonly longestPathHops?: number;
    readonly degreeLimit?: number;
}

export function toTopologyChurnLayout(version: number): GroupLayoutIdentity {
    return { groupRevision: version, presenceRevision: 0, version, state: 'active' };
}

/** A plan that changed one session's edges, an attach replacing a 60 s old layout, unless the input says otherwise. */
export function createTopologyChurnPlan(input: TopologyChurnTestPlanInput): AdminRoomTopologyPlan {
    const delta: TopologyLayoutDelta = { ...EMPTY_TOPOLOGY_LAYOUT_DELTA, changedSessionCount: 1, ...input.delta };
    return {
        publicationId: `publication-${input.version}`,
        requestedAtEpochMs: input.plannedAtEpochMs,
        layout: toTopologyChurnLayout(input.version),
        topology: input.topology ?? 'mesh',
        memberCount: 4,
        degreeLimit: input.degreeLimit ?? 3,
        plan: {
            plannedAtEpochMs: input.plannedAtEpochMs,
            replaced: toReplaced(input.version, input.replacedAgeMs === undefined ? 60_000 : input.replacedAgeMs),
            causes: input.causes ?? ['join'],
            delta,
            longestPathHops: input.longestPathHops ?? 1,
            change: isEmptyTopologyLayoutDelta(delta) ? null : input.change ?? { kind: 'attach' }
        }
    };
}

export function createTopologyChurnRemoval(version: number, requestedAtEpochMs: number): AdminRoomTopologyPlan {
    return { ...createTopologyChurnPlan({ version, plannedAtEpochMs: requestedAtEpochMs }), plan: null };
}

function toReplaced(version: number, ageMs: number | null): ReplacedTopologyLayout | null {
    return ageMs === null ? null : { layout: toTopologyChurnLayout(version - 1), ageMs };
}
