import type { GroupTopologyReplanningMode } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';

import type { TopologyChurnPhaseSpec } from './compute-topology-churn-phase-schedule.ts';

export interface TopologyChurnRoomSpec {
    readonly index: number;
    readonly replanning: GroupTopologyReplanningMode;
    readonly memberCount: number;
    /** Each present member opens a ticketed WebSocket after formation, the socket the room's RTT reports go over. */
    readonly opensRttSockets: boolean;
    readonly phases: readonly TopologyChurnPhaseSpec[];
}

export interface TopologyChurnRoomShape {
    readonly memberCount: number;
    readonly opensRttSockets: boolean;
    readonly phases: readonly TopologyChurnPhaseSpec[];
}

const TOPOLOGY_CHURN_REPLANNING_MODES = [
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
    durationMs: 90_000,
    interleaved: 'none'
}];

export const TOPOLOGY_CHURN_ROOM_SPECS: readonly TopologyChurnRoomSpec[] = toTopologyChurnRoomSpecs(
    [3, 8, 20].map((memberCount) => ({ memberCount, opensRttSockets: false, phases: NINETY_SECOND_CHURN_PHASES }))
);

const LEADER_PHASES: readonly TopologyChurnPhaseSpec[] = [
    { name: 'leader', shape: 'appointments', count: 4, intervalMs: 10_000 },
    { name: 'leader-churn', shape: 'alternate', durationMs: 45_000, interleaved: 'appoint-deepest' }
];

const RTT_PHASES: readonly TopologyChurnPhaseSpec[] = [
    { name: 'rtt-uniform', shape: 'rtt-repeat', matrix: 'uniform' },
    { name: 'rtt-skewed', shape: 'rtt-repeat', matrix: 'skewed' }
];

const RTT_MESH_PHASES: readonly TopologyChurnPhaseSpec[] = [
    { name: 'rtt-shift', shape: 'rtt-rounds', roundIntervalMs: 10_000, durationMs: 120_000 },
    { name: 'rtt-churn', shape: 'alternate', durationMs: 45_000, interleaved: 'report-rtt' }
];

export const TOPOLOGY_RESHAPE_ROOM_SPECS: readonly TopologyChurnRoomSpec[] = toTopologyChurnRoomSpecs([
    {
        memberCount: 4,
        opensRttSockets: false,
        phases: [
            { name: 'ramp-up', shape: 'ramp', toMemberCount: 'one-past-mesh-entry' },
            { name: 'ramp-down', shape: 'ramp', toMemberCount: 'one-below-tree-entry' },
            { name: 'flap', shape: 'alternate', durationMs: 90_000, interleaved: 'none' }
        ]
    },
    { memberCount: 8, opensRttSockets: false, phases: LEADER_PHASES },
    { memberCount: 12, opensRttSockets: false, phases: LEADER_PHASES },
    { memberCount: 8, opensRttSockets: true, phases: RTT_PHASES },
    { memberCount: 20, opensRttSockets: true, phases: RTT_MESH_PHASES }
]);
