import type { GroupTopologyReplanningMode } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';

import type { TopologyChurnPhaseSpec } from './compute-topology-churn-phase-schedule.ts';

export interface TopologyChurnRoomSpec {
    readonly index: number;
    readonly replanning: GroupTopologyReplanningMode;
    readonly memberCount: number;
    readonly phases: readonly TopologyChurnPhaseSpec[];
}

export interface TopologyChurnRoomShape {
    readonly memberCount: number;
    readonly phases: readonly TopologyChurnPhaseSpec[];
}

export const TOPOLOGY_CHURN_REPLANNING_MODES = [
    'auto',
    'debounced'
] as const satisfies readonly GroupTopologyReplanningMode[];

export function toTopologyChurnRoomSpecs(shapes: readonly TopologyChurnRoomShape[]): readonly TopologyChurnRoomSpec[] {
    return TOPOLOGY_CHURN_REPLANNING_MODES.flatMap((replanning) => shapes.map((shape) => ({ replanning, ...shape })))
        .map((spec, index) => ({ index, ...spec }));
}

const NINETY_SECOND_CHURN_PHASES: readonly TopologyChurnPhaseSpec[] = [{
    name: 'churn',
    shape: 'alternate',
    durationMs: 90_000
}];

export const TOPOLOGY_CHURN_ROOM_SPECS: readonly TopologyChurnRoomSpec[] = toTopologyChurnRoomSpecs(
    [3, 8, 20].map((memberCount) => ({ memberCount, phases: NINETY_SECOND_CHURN_PHASES }))
);

export const TOPOLOGY_RESHAPE_ROOM_SPECS: readonly TopologyChurnRoomSpec[] = toTopologyChurnRoomSpecs([{
    memberCount: 4,
    phases: [
        { name: 'ramp-up', shape: 'ramp', toMemberCount: 'one-past-mesh-entry' },
        { name: 'ramp-down', shape: 'ramp', toMemberCount: 'one-below-tree-entry' },
        { name: 'flap', shape: 'alternate', durationMs: 90_000 }
    ]
}]);
