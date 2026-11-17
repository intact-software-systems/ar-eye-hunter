import type { TopologyChurnPhaseSpec } from '@shared-test/black-box-runner/topology-churn/phases/compute-topology-churn-phase-schedule.ts';
import {
    TOPOLOGY_CHURN_ROOM_SPECS,
    TOPOLOGY_RESHAPE_ROOM_SPECS,
    toTopologyChurnRoomSpecs
} from '@shared-test/black-box-runner/topology-churn/phases/topology-churn-room-specs.ts';
import { describe, expect, it } from 'vitest';

const SHORT_CHURN: TopologyChurnPhaseSpec = { name: 'churn', shape: 'alternate', durationMs: 9_000, interleaved: 'none' };
const LONG_CHURN: TopologyChurnPhaseSpec = { name: 'churn', shape: 'alternate', durationMs: 30_000, interleaved: 'none' };
const NINETY_SECOND_CHURN: TopologyChurnPhaseSpec = { name: 'churn', shape: 'alternate', durationMs: 90_000, interleaved: 'none' };

describe('toTopologyChurnRoomSpecs', () => {
    it('crosses both replanning modes with every room shape, mode by mode, and numbers the rooms in that order', () => {
        const specs = toTopologyChurnRoomSpecs([
            { memberCount: 5, opensRttSockets: false, phases: [SHORT_CHURN] },
            { memberCount: 12, opensRttSockets: true, phases: [SHORT_CHURN, LONG_CHURN] }
        ]);

        expect(specs).toEqual([
            { index: 0, replanning: 'auto', memberCount: 5, opensRttSockets: false, phases: [SHORT_CHURN] },
            { index: 1, replanning: 'auto', memberCount: 12, opensRttSockets: true, phases: [SHORT_CHURN, LONG_CHURN] },
            { index: 2, replanning: 'debounced', memberCount: 5, opensRttSockets: false, phases: [SHORT_CHURN] },
            { index: 3, replanning: 'debounced', memberCount: 12, opensRttSockets: true, phases: [SHORT_CHURN, LONG_CHURN] }
        ]);
    });
});

describe('TOPOLOGY_CHURN_ROOM_SPECS', () => {
    it('the churn room set is rooms of 3, 8 and 20 members, each with one 90 s churn phase, under both modes', () => {
        // The six rooms the churn measurement has always run, in the order it has always run them.
        expect(TOPOLOGY_CHURN_ROOM_SPECS).toEqual([
            { index: 0, replanning: 'auto', memberCount: 3, opensRttSockets: false, phases: [NINETY_SECOND_CHURN] },
            { index: 1, replanning: 'auto', memberCount: 8, opensRttSockets: false, phases: [NINETY_SECOND_CHURN] },
            { index: 2, replanning: 'auto', memberCount: 20, opensRttSockets: false, phases: [NINETY_SECOND_CHURN] },
            { index: 3, replanning: 'debounced', memberCount: 3, opensRttSockets: false, phases: [NINETY_SECOND_CHURN] },
            { index: 4, replanning: 'debounced', memberCount: 8, opensRttSockets: false, phases: [NINETY_SECOND_CHURN] },
            { index: 5, replanning: 'debounced', memberCount: 20, opensRttSockets: false, phases: [NINETY_SECOND_CHURN] }
        ]);
    });
});

describe('TOPOLOGY_RESHAPE_ROOM_SPECS', () => {
    it('the reshape room set is a room of 4 that ramps and flaps, led rooms of 8 and 12 re-rooted quiet and under churn, and a room of 8 that reports RTT, under both modes', () => {
        const kindPhases: readonly TopologyChurnPhaseSpec[] = [
            { name: 'ramp-up', shape: 'ramp', toMemberCount: 'one-past-mesh-entry' },
            { name: 'ramp-down', shape: 'ramp', toMemberCount: 'one-below-tree-entry' },
            { name: 'flap', shape: 'alternate', durationMs: 90_000, interleaved: 'none' }
        ];
        const leaderPhases: readonly TopologyChurnPhaseSpec[] = [
            { name: 'leader', shape: 'appointments', count: 4, intervalMs: 10_000 },
            { name: 'leader-churn', shape: 'alternate', durationMs: 45_000, interleaved: 'appoint-deepest' }
        ];
        const rttPhases: readonly TopologyChurnPhaseSpec[] = [
            { name: 'rtt-uniform', shape: 'rtt-repeat', matrix: 'uniform' },
            { name: 'rtt-skewed', shape: 'rtt-repeat', matrix: 'skewed' }
        ];

        expect(TOPOLOGY_RESHAPE_ROOM_SPECS).toEqual([
            { index: 0, replanning: 'auto', memberCount: 4, opensRttSockets: false, phases: kindPhases },
            { index: 1, replanning: 'auto', memberCount: 8, opensRttSockets: false, phases: leaderPhases },
            { index: 2, replanning: 'auto', memberCount: 12, opensRttSockets: false, phases: leaderPhases },
            { index: 3, replanning: 'auto', memberCount: 8, opensRttSockets: true, phases: rttPhases },
            { index: 4, replanning: 'debounced', memberCount: 4, opensRttSockets: false, phases: kindPhases },
            { index: 5, replanning: 'debounced', memberCount: 8, opensRttSockets: false, phases: leaderPhases },
            { index: 6, replanning: 'debounced', memberCount: 12, opensRttSockets: false, phases: leaderPhases },
            { index: 7, replanning: 'debounced', memberCount: 8, opensRttSockets: true, phases: rttPhases }
        ]);
    });
});

describe('the exported room sets', () => {
    it('number every room of a set uniquely, since the room\'s group id is derived from its index', () => {
        for (const roomSpecs of [TOPOLOGY_CHURN_ROOM_SPECS, TOPOLOGY_RESHAPE_ROOM_SPECS]) {
            expect(new Set(roomSpecs.map((spec) => spec.index)).size).toBe(roomSpecs.length);
        }
    });
});
