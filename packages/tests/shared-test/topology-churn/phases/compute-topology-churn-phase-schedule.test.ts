import {
    DEFAULT_MESH_EXIT_WIDTH,
    DEFAULT_TREE_EXIT_WIDTH,
    resolveTopologyKindWithHysteresis
} from '@shared-server/rallar-system/topology/planning/topology-kind-hysteresis.ts';
import {
    computeTopologyChurnPhaseSchedule,
    type TopologyChurnPhaseSpec
} from '@shared-test/black-box-runner/topology-churn/phases/compute-topology-churn-phase-schedule.ts';
import type { EffectiveGroupTopologyConfig } from '@shared/api/graph-topology-management-types.ts';
import type { RallarRtcTopologyKind } from '@shared/api/overlay-topology.ts';
import { describe, expect, it } from 'vitest';

// The server's defaults, as the room's topology-config read serves them: a tree from 5 members, a mesh from 16.
const SERVED_TOPOLOGY_CONFIG: EffectiveGroupTopologyConfig = {
    topologyKind: 'auto',
    degreeLimit: 5,
    treeMinSize: 5,
    meshMinSize: 16,
    meshParamK: 2
};

const RAMP_UP: TopologyChurnPhaseSpec = { name: 'ramp-up', shape: 'ramp', toMemberCount: 'one-past-mesh-entry' };
const RAMP_DOWN: TopologyChurnPhaseSpec = { name: 'ramp-down', shape: 'ramp', toMemberCount: 'one-below-tree-entry' };

describe('computeTopologyChurnPhaseSchedule', () => {
    it('alternates join and leave every interval from the phase\'s start, starting with a join', () => {
        const schedule = computeTopologyChurnPhaseSchedule({
            spec: { name: 'churn', shape: 'alternate', durationMs: 90_000 },
            presentMemberCount: 8,
            topologyConfig: SERVED_TOPOLOGY_CONFIG
        });

        // 90 s at one step every 3 s: 30 steps, at 0, 3 000, …, 87 000.
        expect(schedule.name).toBe('churn');
        expect(schedule.durationMs).toBe(90_000);
        expect(schedule.steps).toHaveLength(30);
        expect(schedule.steps.slice(0, 4)).toEqual([
            { offsetMs: 0, action: { kind: 'join' } },
            { offsetMs: 3_000, action: { kind: 'leave' } },
            { offsetMs: 6_000, action: { kind: 'join' } },
            { offsetMs: 9_000, action: { kind: 'leave' } }
        ]);
        expect(schedule.steps.at(-1)).toEqual({ offsetMs: 87_000, action: { kind: 'leave' } });
        expect(schedule.steps.map((step) => step.action.kind)).toEqual(
            Array.from({ length: 15 }, () => ['join', 'leave']).flat()
        );
    });

    it('places no step at the phase\'s end', () => {
        const schedule = computeTopologyChurnPhaseSchedule({
            spec: { name: 'churn', shape: 'alternate', durationMs: 9_000 },
            presentMemberCount: 8,
            topologyConfig: SERVED_TOPOLOGY_CONFIG
        });

        // 9 000 itself is the phase's end, so the last step is at 6 000.
        expect(schedule).toEqual({
            name: 'churn',
            durationMs: 9_000,
            steps: [
                { offsetMs: 0, action: { kind: 'join' } },
                { offsetMs: 3_000, action: { kind: 'leave' } },
                { offsetMs: 6_000, action: { kind: 'join' } }
            ]
        });
    });

    it('places a step in a phase\'s last partial interval', () => {
        const schedule = computeTopologyChurnPhaseSchedule({
            spec: { name: 'churn', shape: 'alternate', durationMs: 10_000 },
            presentMemberCount: 8,
            topologyConfig: SERVED_TOPOLOGY_CONFIG
        });

        // 9 000 lies before the phase's end at 10 000, so it is a step.
        expect(schedule.steps.map((step) => step.offsetMs)).toEqual([0, 3_000, 6_000, 9_000]);
        expect(schedule.durationMs).toBe(10_000);
    });

    it('flaps like churn, under its own name', () => {
        const schedule = computeTopologyChurnPhaseSchedule({
            spec: { name: 'flap', shape: 'alternate', durationMs: 90_000 },
            presentMemberCount: 4,
            topologyConfig: SERVED_TOPOLOGY_CONFIG
        });

        expect(schedule.name).toBe('flap');
        expect(schedule.durationMs).toBe(90_000);
        expect(schedule.steps).toEqual(
            Array.from({ length: 30 }, (_, index) => ({
                offsetMs: index * 3_000,
                action: { kind: index % 2 === 0 ? 'join' : 'leave' }
            }))
        );
    });

    it('ramps up one join per interval to one member past the mesh entry', () => {
        const schedule = computeTopologyChurnPhaseSchedule({
            spec: RAMP_UP,
            presentMemberCount: 4,
            topologyConfig: SERVED_TOPOLOGY_CONFIG
        });

        // From 4 to 17 members: 13 joins, at 0, 3 000, …, 36 000; the phase lasts 13 intervals.
        expect(schedule.name).toBe('ramp-up');
        expect(schedule.durationMs).toBe(39_000);
        expect(schedule.steps).toEqual(
            Array.from({ length: 13 }, (_, index) => ({ offsetMs: index * 3_000, action: { kind: 'join' } }))
        );
        expect(schedule.steps.at(-1)?.offsetMs).toBe(36_000);
    });

    it('ramps down one leave per interval to one member below the tree entry', () => {
        const schedule = computeTopologyChurnPhaseSchedule({
            spec: RAMP_DOWN,
            presentMemberCount: 17,
            topologyConfig: SERVED_TOPOLOGY_CONFIG
        });

        // From 17 to 4 members: 13 leaves, at 0, 3 000, …, 36 000.
        expect(schedule.name).toBe('ramp-down');
        expect(schedule.durationMs).toBe(39_000);
        expect(schedule.steps).toEqual(
            Array.from({ length: 13 }, (_, index) => ({ offsetMs: index * 3_000, action: { kind: 'leave' } }))
        );
    });

    it('has no step and no duration for a ramp already at its target', () => {
        expect(computeTopologyChurnPhaseSchedule({
            spec: RAMP_UP,
            presentMemberCount: 17,
            topologyConfig: SERVED_TOPOLOGY_CONFIG
        })).toEqual({ name: 'ramp-up', steps: [], durationMs: 0 });
        expect(computeTopologyChurnPhaseSchedule({
            spec: RAMP_DOWN,
            presentMemberCount: 4,
            topologyConfig: SERVED_TOPOLOGY_CONFIG
        })).toEqual({ name: 'ramp-down', steps: [], durationMs: 0 });
    });
});

describe('computeTopologyChurnPhaseSchedule against the planner\'s kind selection', () => {
    it('the kind room crosses the planner\'s kind thresholds at 5 and 16 going up, 11 and 4 going down, and at every flap step', () => {
        const flap: TopologyChurnPhaseSpec = { name: 'flap', shape: 'alternate', durationMs: 90_000 };

        expect(computeKindChangeSizes(RAMP_UP, 4)).toEqual([5, 16]);
        // The mesh holds down to 12 (16 less the exit width 4) and the tree down to 5 (no exit width).
        expect(computeKindChangeSizes(RAMP_DOWN, 17)).toEqual([11, 4]);
        // A tree from 5 and a star at 4: every join and every leave of the flap changes the kind.
        expect(computeKindChangeSizes(flap, 4)).toEqual(Array.from({ length: 15 }, () => [5, 4]).flat());
    });
});

/** The member counts at which the planner's kind changes, walking the schedule from the present count. */
function computeKindChangeSizes(spec: TopologyChurnPhaseSpec, presentMemberCount: number): readonly number[] {
    const schedule = computeTopologyChurnPhaseSchedule({
        spec,
        presentMemberCount,
        topologyConfig: SERVED_TOPOLOGY_CONFIG
    });
    const resolveKind = (activeSize: number, previousKind: RallarRtcTopologyKind | undefined): RallarRtcTopologyKind =>
        resolveTopologyKindWithHysteresis({
            activeSize,
            treeMinSize: SERVED_TOPOLOGY_CONFIG.treeMinSize,
            meshMinSize: SERVED_TOPOLOGY_CONFIG.meshMinSize,
            meshExitWidth: DEFAULT_MESH_EXIT_WIDTH,
            treeExitWidth: DEFAULT_TREE_EXIT_WIDTH,
            previousKind
        });
    let size = presentMemberCount;
    let kind = resolveKind(size, undefined);
    const changeSizes: number[] = [];
    for (const step of schedule.steps) {
        size += step.action.kind === 'join' ? 1 : -1;
        const nextKind = resolveKind(size, kind);
        if (nextKind !== kind) {
            changeSizes.push(size);
        }
        kind = nextKind;
    }
    return changeSizes;
}
