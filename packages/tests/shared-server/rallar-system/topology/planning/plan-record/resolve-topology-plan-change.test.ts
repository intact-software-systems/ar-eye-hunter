import { describe, expect, it } from 'vitest';

import { computeTopologyLayoutDelta } from '@shared-server/rallar-system/topology/planning/plan-record/compute-topology-layout-delta.ts';
import { resolveTopologyPlanChange } from '@shared-server/rallar-system/topology/planning/plan-record/resolve-topology-plan-change.ts';
import type { RtcTopologyPlanDerivation } from '@shared-server/rallar-system/topology/planning/plan-record/rtc-topology-plan-derivation.ts';
import type { TopologyLayoutDelta } from '@shared/api/topology-plan/rtc-topology-plan-record.ts';
import { TOPOLOGY_RESHAPE_REASONS, type TopologyReshapeReason } from '@shared/api/topology-plan/topology-plan-change.ts';

import {
    computeRtcTopologyFixtureLeave,
    computeRtcTopologyFixturePlan,
    computeRtcTopologyFixtureRebuild,
    createRtcTopologyFixtureGroup,
    RTC_TOPOLOGY_MESH_OPTIONS,
    RTC_TOPOLOGY_TREE_OPTIONS,
    type RtcTopologyFixtureLeaveInput,
    type RtcTopologyFixtureReplan
} from '../rtc-topology-planning-fixtures.ts';

const EMPTY_DELTA: TopologyLayoutDelta = {
    joinedSessionCount: 0,
    leftSessionCount: 0,
    changedSessionCount: 0,
    reroutedSessionCount: 0,
    acceptingSessionCount: 0,
    maxJoinerEdgesPerSession: 0
};
const JOIN_DELTA: TopologyLayoutDelta = {
    ...EMPTY_DELTA,
    joinedSessionCount: 1,
    changedSessionCount: 1,
    acceptingSessionCount: 1,
    maxJoinerEdgesPerSession: 1
};
const LEAVE_DELTA: TopologyLayoutDelta = { ...EMPTY_DELTA, leftSessionCount: 1, changedSessionCount: 1 };
const MESH_OF_TWENTY = { options: RTC_TOPOLOGY_MESH_OPTIONS, memberCount: 20, joinerCount: 0 };
const TREE_OF_EIGHT = { options: RTC_TOPOLOGY_TREE_OPTIONS, memberCount: 8, joinerCount: 0 };
const SWEEP_EVENTS = ['leave', 'join', 'leave-and-join'] as const;

describe('resolveTopologyPlanChange', () => {
    it.each<RtcTopologyPlanDerivation>([
        { method: 'established' },
        { method: 'incremental' },
        { method: 'rebuilt', reason: 'refinement' }
    ])('a plan that changes no member and no edge is no topology work, however it was derived ($method)', (derivation) => {
        expect(resolveTopologyPlanChange(derivation, EMPTY_DELTA)).toBeNull();
    });

    it('a rebuilt plan is a reshape for the rebuild\'s reason', () => {
        expect(resolveTopologyPlanChange({ method: 'rebuilt', reason: 'delta-too-large' }, JOIN_DELTA))
            .toEqual({ kind: 'reshape', reason: 'delta-too-large' });
    });

    it('an established plan is an attach, since nobody had a place to lose', () => {
        expect(resolveTopologyPlanChange({ method: 'established' }, { ...EMPTY_DELTA, joinedSessionCount: 3 }))
            .toEqual({ kind: 'attach' });
    });

    it('an incremental plan that a member left is a repair', () => {
        expect(resolveTopologyPlanChange({ method: 'incremental' }, LEAVE_DELTA)).toEqual({ kind: 'repair' });
    });

    it('an incremental plan in which a member left and another joined is a repair', () => {
        const delta: TopologyLayoutDelta = { ...JOIN_DELTA, leftSessionCount: 1, changedSessionCount: 2 };

        expect(resolveTopologyPlanChange({ method: 'incremental' }, delta)).toEqual({ kind: 'repair' });
    });

    it('an incremental plan that nobody left is an attach', () => {
        expect(resolveTopologyPlanChange({ method: 'incremental' }, JOIN_DELTA)).toEqual({ kind: 'attach' });
    });
});

describe('the kind of the planner\'s own plans', () => {
    it('a join on a tree is an attach that reroutes nobody', () => {
        const formed = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_TREE_OPTIONS,
            group: createRtcTopologyFixtureGroup(6),
            previous: undefined
        }).snapshot;
        const joined = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_TREE_OPTIONS,
            group: createRtcTopologyFixtureGroup(7),
            previous: formed
        });

        const delta = computeTopologyLayoutDelta(formed, joined.snapshot);

        expect(resolveTopologyPlanChange(joined.derivation, delta)).toEqual({ kind: 'attach' });
        expect(delta.reroutedSessionCount).toBe(0);
    });

    it('a leaf\'s leave is a repair that changes nobody else', () => {
        const left = computeRtcTopologyFixtureLeave({
            options: RTC_TOPOLOGY_TREE_OPTIONS,
            memberCount: 8,
            leaver: (nextHopCount) => nextHopCount === 1,
            joinerCount: 0
        });

        const delta = computeTopologyLayoutDelta(left.previous, left.planned.snapshot);

        expect(resolveTopologyPlanChange(left.planned.derivation, delta)).toEqual({ kind: 'repair' });
        expect(delta.reroutedSessionCount).toBe(0);
        expect(readChangedStayerSessionIds(left)).toEqual(left.previous.nextHopsBySessionId[left.leaverSessionId]);
    });

    it('a relay\'s leave is a repair that changes only its dependants', () => {
        const left = computeRtcTopologyFixtureLeave({
            options: RTC_TOPOLOGY_TREE_OPTIONS,
            memberCount: 8,
            leaver: (nextHopCount) => nextHopCount > 1,
            joinerCount: 0
        });
        const dependantSessionIds = left.previous.nextHopsBySessionId[left.leaverSessionId] ?? [];

        const delta = computeTopologyLayoutDelta(left.previous, left.planned.snapshot);

        expect(resolveTopologyPlanChange(left.planned.derivation, delta)).toEqual({ kind: 'repair' });
        expect(delta.reroutedSessionCount).toBe(0);
        const changedSessionIds = readChangedStayerSessionIds(left);
        expect(changedSessionIds.length).toBeGreaterThan(0);
        expect(changedSessionIds.every((sessionId) => dependantSessionIds.includes(sessionId))).toBe(true);
    });

    describe.each(TOPOLOGY_RESHAPE_REASONS)('each rebuild reason is a reshape: %s', (reason) => {
        it('names the rebuild a reshape for its reason', () => {
            const rebuilt = computeRtcTopologyFixtureRebuild(reason);

            const delta = computeTopologyLayoutDelta(rebuilt.previous, rebuilt.planned.snapshot);

            expect(rebuilt.planned.derivation).toEqual({ method: 'rebuilt', reason });
            expect(resolveTopologyPlanChange(rebuilt.planned.derivation, delta)).toEqual({ kind: 'reshape', reason });
        });
    });

    it('a rebuild that plans the same graph is no topology work', () => {
        // A full rebuild of an unchanged tree with nothing measured is derived as a refinement, yet plans the same map.
        const formed = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_TREE_OPTIONS,
            group: createRtcTopologyFixtureGroup(6),
            previous: undefined
        }).snapshot;
        const rebuilt = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_TREE_OPTIONS,
            group: createRtcTopologyFixtureGroup(6),
            previous: formed,
            planningIntent: 'full-rebuild'
        });

        const delta = computeTopologyLayoutDelta(formed, rebuilt.snapshot);

        expect(rebuilt.derivation).toEqual({ method: 'rebuilt', reason: 'refinement' });
        expect(rebuilt.snapshot.nextHopsBySessionId).toEqual(formed.nextHopsBySessionId);
        expect(resolveTopologyPlanChange(rebuilt.derivation, delta)).toBeNull();
    });
});

describe('what a single join or leave in a mesh of twenty reroutes today', () => {
    const formed = computeRtcTopologyFixturePlan({
        options: RTC_TOPOLOGY_MESH_OPTIONS,
        group: createRtcTopologyFixtureGroup(20),
        previous: undefined
    }).snapshot;

    it('an incremental join into a mesh is an attach that reroutes nobody', () => {
        const joined = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_MESH_OPTIONS,
            group: createRtcTopologyFixtureGroup(21),
            previous: formed
        });

        const delta = computeTopologyLayoutDelta(formed, joined.snapshot);

        expect(joined.derivation).toEqual({ method: 'incremental' });
        expect(resolveTopologyPlanChange(joined.derivation, delta)).toEqual({ kind: 'attach' });
        expect(delta.reroutedSessionCount).toBe(0);
    });

    it('an incremental leave from a mesh is a repair that reroutes nobody', () => {
        const left = computeRtcTopologyFixtureLeave({ ...MESH_OF_TWENTY, leaver: 'peer-7' });

        const delta = computeTopologyLayoutDelta(left.previous, left.planned.snapshot);

        expect(left.planned.derivation).toEqual({ method: 'incremental' });
        expect(resolveTopologyPlanChange(left.planned.derivation, delta)).toEqual({ kind: 'repair' });
        expect(delta.reroutedSessionCount).toBe(0);
    });

    it('a leave from a mesh that reroutes members it did not involve is rebuilt, so it is a reshape', () => {
        // The evolved mesh breaks an invariant, and the rebuild moves edges between members peer-4 never touched.
        const left = computeRtcTopologyFixtureLeave({ ...MESH_OF_TWENTY, leaver: 'peer-4' });

        const delta = computeTopologyLayoutDelta(left.previous, left.planned.snapshot);

        expect(left.planned.derivation).toEqual({ method: 'rebuilt', reason: 'invariant-violation' });
        expect(resolveTopologyPlanChange(left.planned.derivation, delta))
            .toEqual({ kind: 'reshape', reason: 'invariant-violation' });
        expect(delta.reroutedSessionCount).toBe(3);
    });
});

describe('the planner\'s plans over every single leave of a mesh of twenty and a tree of eight', () => {
    const meshSweep = computeRoomSweep(MESH_OF_TWENTY);
    const treeSweep = computeRoomSweep(TREE_OF_EIGHT);

    it.each([
        { room: 'a mesh of twenty', sweep: meshSweep },
        { room: 'a tree of eight', sweep: treeSweep }
    ])('no incremental plan reroutes a member it did not involve ($room)', ({ sweep }) => {
        const incrementalPlans = sweep.filter((plan) => plan.derivation.method === 'incremental');

        expect(new Set(incrementalPlans.map((plan) => plan.event))).toEqual(new Set(SWEEP_EVENTS));
        expect(incrementalPlans.filter((plan) => plan.delta.reroutedSessionCount > 0)).toEqual([]);
    });

    // These pin the planner's CURRENT evolution: the count should fall if evolution learns to repair these leaves,
    // and each leave counted here will be a reshape once reshapes are gated.
    it('today 9 of the 20 single leaves from a 20-member mesh cannot be repaired incrementally and are rebuilt', () => {
        expect(countSingleLeaveRebuildReasons(meshSweep)).toEqual({ 'invariant-violation': 9 });
    });

    it('today 1 of the 8 single leaves from an 8-member tree cannot be repaired incrementally and are rebuilt', () => {
        expect(countSingleLeaveRebuildReasons(treeSweep)).toEqual({ 'invariant-violation': 1 });
    });
});

type SweepEvent = (typeof SWEEP_EVENTS)[number];

interface SweptPlan {
    readonly event: SweepEvent;
    readonly leaverSessionId: string | null;
    readonly derivation: RtcTopologyPlanDerivation;
    readonly delta: TopologyLayoutDelta;
}

/** Every single leave, one join, and every single leave with one join in the same plan, from the formed room. */
function computeRoomSweep(room: Omit<RtcTopologyFixtureLeaveInput, 'leaver'>): readonly SweptPlan[] {
    const formed = computeRtcTopologyFixturePlan({
        options: room.options,
        group: createRtcTopologyFixtureGroup(room.memberCount),
        previous: undefined
    }).snapshot;
    const joined = computeRtcTopologyFixturePlan({
        options: room.options,
        group: createRtcTopologyFixtureGroup(room.memberCount + 1),
        previous: formed
    });
    const leaves = formed.activeSessionIds.flatMap((leaverSessionId) =>
        ([0, 1] as const).map((joinerCount) => {
            const left = computeRtcTopologyFixtureLeave({ ...room, leaver: leaverSessionId, joinerCount });
            return toSweptPlan(joinerCount === 0 ? 'leave' : 'leave-and-join', leaverSessionId, left);
        })
    );
    return [toSweptPlan('join', null, { previous: formed, planned: joined }), ...leaves];
}

function toSweptPlan(event: SweepEvent, leaverSessionId: string | null, replan: RtcTopologyFixtureReplan): SweptPlan {
    return {
        event,
        leaverSessionId,
        derivation: replan.planned.derivation,
        delta: computeTopologyLayoutDelta(replan.previous, replan.planned.snapshot)
    };
}

function countSingleLeaveRebuildReasons(sweep: readonly SweptPlan[]): Partial<Record<TopologyReshapeReason, number>> {
    const counts: Partial<Record<TopologyReshapeReason, number>> = {};
    for (const plan of sweep) {
        if (plan.event === 'leave' && plan.derivation.method === 'rebuilt') {
            counts[plan.derivation.reason] = (counts[plan.derivation.reason] ?? 0) + 1;
        }
    }
    return counts;
}

/** The staying members whose next hops the plan changed, in the planner's member order. */
function readChangedStayerSessionIds(replan: RtcTopologyFixtureReplan): readonly string[] {
    const before = replan.previous.nextHopsBySessionId;
    const after = replan.planned.snapshot.nextHopsBySessionId;
    return replan.planned.snapshot.activeSessionIds.filter((sessionId) => {
        const nextHopsBefore = before[sessionId] ?? [];
        const nextHopsAfter = after[sessionId] ?? [];
        return nextHopsBefore.length !== nextHopsAfter.length ||
            nextHopsBefore.some((nextHop) => !nextHopsAfter.includes(nextHop));
    });
}
