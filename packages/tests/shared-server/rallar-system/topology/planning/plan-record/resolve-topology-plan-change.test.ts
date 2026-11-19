import { describe, expect, it } from 'vitest';

import { computeTopologyLayoutDelta } from '@shared-server/rallar-system/topology/planning/plan-record/compute-topology-layout-delta.ts';
import { resolveTopologyPlanChange } from '@shared-server/rallar-system/topology/planning/plan-record/resolve-topology-plan-change.ts';
import type { RtcTopologyPlanDerivation } from '@shared-server/rallar-system/topology/planning/plan-record/rtc-topology-plan-derivation.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { TopologyLayoutDelta } from '@shared/api/topology-plan/rtc-topology-plan-record.ts';
import { TOPOLOGY_RESHAPE_REASONS, type TopologyReshapeReason } from '@shared/api/topology-plan/topology-plan-change.ts';
import type {
    HeldTopologyReshapeReason,
    TopologyReshapePermission
} from '@shared/api/topology-plan/topology-reshape-gate.ts';

import { EMPTY_TOPOLOGY_LAYOUT_DELTA } from '../../../../../shared/api/topology-plan/empty-topology-layout-delta.ts';
import { toRtcTopologyGroupWithDirector } from '../../rtc-topology-test-fixtures.ts';
import {
    computeRtcTopologyFixtureDeparture,
    computeRtcTopologyFixtureLeave,
    computeRtcTopologyFixtureMeasuredLeave,
    computeRtcTopologyFixturePlan,
    computeRtcTopologyFixtureRebuild,
    createRtcTopologyFixtureGroup,
    isConnectedRtcTopologyFixtureLayout,
    RTC_TOPOLOGY_MESH_OPTIONS,
    RTC_TOPOLOGY_SIZE_SELECTED_OPTIONS,
    RTC_TOPOLOGY_TREE_OPTIONS,
    type RtcTopologyFixtureLayout,
    type RtcTopologyFixtureLeaveInput,
    type RtcTopologyFixtureReplan
} from '../rtc-topology-planning-fixtures.ts';

const JOIN_DELTA: TopologyLayoutDelta = {
    ...EMPTY_TOPOLOGY_LAYOUT_DELTA,
    joinedSessionCount: 1,
    changedSessionCount: 1,
    acceptingSessionCount: 1,
    maxJoinerEdgesPerSession: 1
};
const LEAVE_DELTA: TopologyLayoutDelta = { ...EMPTY_TOPOLOGY_LAYOUT_DELTA, leftSessionCount: 1, changedSessionCount: 1 };
const MESH_OF_TWENTY = { options: RTC_TOPOLOGY_MESH_OPTIONS, memberCount: 20, joinerCount: 0 };
// The pair counts split every pair of the formed members by whether the formed layout links them.
const SWEEP_ROOMS = [
    { room: 'a mesh of twenty', options: RTC_TOPOLOGY_MESH_OPTIONS, memberCount: 20, linkedPairCount: 37, unlinkedPairCount: 153 },
    { room: 'a tree of eight', options: RTC_TOPOLOGY_TREE_OPTIONS, memberCount: 8, linkedPairCount: 7, unlinkedPairCount: 21 },
    { room: 'a tree of twelve', options: RTC_TOPOLOGY_TREE_OPTIONS, memberCount: 12, linkedPairCount: 11, unlinkedPairCount: 55 },
    { room: 'a tree of thirty', options: RTC_TOPOLOGY_TREE_OPTIONS, memberCount: 30, linkedPairCount: 29, unlinkedPairCount: 406 },
    { room: 'a mesh of thirty', options: RTC_TOPOLOGY_MESH_OPTIONS, memberCount: 30, linkedPairCount: 57, unlinkedPairCount: 378 }
];
const SWEEP_EVENTS = ['leave', 'join', 'leave-and-join'] as const;
// With the reshape held, a plan rebuilds only when the in-place update itself fails.
const HELD_SWEEP_RESHAPE_REASONS: readonly TopologyReshapeReason[] = ['kind-change', 'leader-rooting', 'delta-too-large', 'refinement'];
// Rooms whose single changes the gate holds: the join selects a mesh past fifteen, or the joiner is appointed director.
const HELD_REASON_SWEEP_ROOMS = [
    {
        room: 'a size-selected tree of fifteen',
        options: RTC_TOPOLOGY_SIZE_SELECTED_OPTIONS,
        memberCount: 15,
        directorJoins: false,
        heldReason: 'kind-change'
    },
    {
        room: 'a tree of fifteen whose joiner is its director',
        options: RTC_TOPOLOGY_TREE_OPTIONS,
        memberCount: 15,
        directorJoins: true,
        heldReason: 'leader-rooting'
    }
] as const;
const MEASURED_ROOMS = [
    { room: 'a measured 20-member mesh', options: RTC_TOPOLOGY_MESH_OPTIONS, memberCount: 20 },
    { room: 'a measured 30-member mesh', options: RTC_TOPOLOGY_MESH_OPTIONS, memberCount: 30 },
    { room: 'a measured 30-member tree', options: RTC_TOPOLOGY_TREE_OPTIONS, memberCount: 30 }
];
// A measured leave plans in milliseconds; the timeout fails a slow repair by its leaver. A repair that never
// returns is a synchronous loop, which no timeout interrupts: the run stalls on that leaver instead of failing.
const MEASURED_LEAVE_TIMEOUT_MS = 10_000;

describe('resolveTopologyPlanChange', () => {
    it.each<RtcTopologyPlanDerivation>([
        { method: 'established' },
        { method: 'incremental' },
        { method: 'rebuilt', reason: 'refinement' }
    ])('a plan that changes no member and no edge is no topology work, however it was derived ($method)', (derivation) => {
        expect(resolveTopologyPlanChange(derivation, EMPTY_TOPOLOGY_LAYOUT_DELTA)).toBeNull();
    });

    it('a rebuilt plan is a reshape for the rebuild\'s reason', () => {
        expect(resolveTopologyPlanChange({ method: 'rebuilt', reason: 'delta-too-large' }, JOIN_DELTA))
            .toEqual({ kind: 'reshape', reason: 'delta-too-large' });
    });

    it('an established plan is an attach, since nobody had a place to lose', () => {
        expect(resolveTopologyPlanChange({ method: 'established' }, { ...EMPTY_TOPOLOGY_LAYOUT_DELTA, joinedSessionCount: 3 }))
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

describe('what a single join or leave in a mesh of twenty reroutes', () => {
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
});

describe.each(SWEEP_ROOMS)('the planner\'s plans over every single leave of $room', ({ options, memberCount }) => {
    // The limit of this sweep: the fixture rooms have no director, so no leader's leave is covered.
    const sweep = computeRoomSweep({ options, memberCount });
    const leaves = sweep.filter((plan) => plan.event === 'leave');
    const leavesWithJoin = sweep.filter((plan) => plan.event === 'leave-and-join');

    it('no incremental plan reroutes a member the change did not involve', () => {
        const incrementalPlans = sweep.filter((plan) => plan.derivation.method === 'incremental');

        expect(new Set(incrementalPlans.map((plan) => plan.event))).toEqual(new Set(SWEEP_EVENTS));
        expect(incrementalPlans.filter((plan) => plan.delta.reroutedSessionCount > 0)).toEqual([]);
    });

    it('every single leave is repaired in place and none is rebuilt', () => {
        expect(leaves).toHaveLength(memberCount);
        expect(leaves.filter((plan) => plan.derivation.method !== 'incremental').map(toRebuiltLeave)).toEqual([]);
    });

    it('every single leave leaves the leaver gone and the rest connected inside the degree limit', () => {
        expect(leaves.filter((plan) => !isValidLeaveLayout(plan.planned, plan.leaverSessionIds)).map(toRebuiltLeave))
            .toEqual([]);
    });

    it('every single leave with a join in the same plan is repaired in place and none is rebuilt', () => {
        expect(leavesWithJoin).toHaveLength(memberCount);
        expect(leavesWithJoin.filter((plan) => plan.derivation.method !== 'incremental').map(toRebuiltLeave)).toEqual([]);
    });
});

describe.each(SWEEP_ROOMS)('the planner\'s plans over every single leave of $room with the reshape held', ({ options, memberCount }) => {
    const sweep = computeRoomSweep({ options, memberCount }, { reshape: 'held' });

    it('sweeps the same plans as the allowed pass', () => {
        expect(sweep).toHaveLength(2 * memberCount + 1);
    });

    it('no plan reroutes a member the change did not involve', () => {
        expect(sweep.filter((plan) => plan.delta.reroutedSessionCount > 0).map(toRebuiltLeave)).toEqual([]);
    });

    it('no plan is rebuilt for a reason the held reshape holds or evolves past', () => {
        expect(
            sweep.filter((plan) => plan.derivation.method === 'rebuilt' && HELD_SWEEP_RESHAPE_REASONS.includes(plan.derivation.reason))
                .map(toRebuiltLeave)
        ).toEqual([]);
    });
});

describe.each(HELD_REASON_SWEEP_ROOMS)(
    'the planner\'s plans over every single leave of $room with the reshape held',
    ({ options, memberCount, directorJoins, heldReason }) => {
        const sweep = computeRoomSweep({ options, memberCount, directorJoins }, { reshape: 'held' });

        it(`holds ${heldReason} at least once`, () => {
            expect(sweep.filter((plan) => plan.heldReshapeReasons.includes(heldReason)).length).toBeGreaterThan(0);
        });

        it('no plan reroutes a member the change did not involve', () => {
            expect(sweep.filter((plan) => plan.delta.reroutedSessionCount > 0).map(toRebuiltLeave)).toEqual([]);
        });

        it('no plan is rebuilt for a reason the held reshape holds or evolves past', () => {
            expect(
                sweep.filter((plan) => plan.derivation.method === 'rebuilt' && HELD_SWEEP_RESHAPE_REASONS.includes(plan.derivation.reason))
                    .map(toRebuiltLeave)
            ).toEqual([]);
        });
    }
);

describe.each(SWEEP_ROOMS)(
    'the planner\'s plans over every pair of members of $room leaving in one plan',
    ({ options, memberCount, linkedPairCount, unlinkedPairCount }) => {
        // A linked pair is the case where the first leaver's repair reaches the second leaver.
        const departures = computeRoomPairSweep({ options, memberCount });

        describe.each([
            { pairs: 'linked', linked: true, pairCount: linkedPairCount },
            { pairs: 'unlinked', linked: false, pairCount: unlinkedPairCount }
        ])('$pairs pairs', ({ linked, pairCount }) => {
            const pairs = departures.filter((plan) => plan.linked === linked);

            it('every pair is repaired in place and none is rebuilt', () => {
                expect(pairs).toHaveLength(pairCount);
                expect(pairs.filter((plan) => plan.derivation.method !== 'incremental').map(toRebuiltLeave)).toEqual([]);
            });

            it('every pair leaves both leavers gone and the rest connected inside the degree limit', () => {
                expect(pairs.filter((plan) => !isValidLeaveLayout(plan.planned, plan.leaverSessionIds)).map(toRebuiltLeave))
                    .toEqual([]);
            });

            it('no pair\'s repair reroutes a member the leaves did not involve', () => {
                expect(pairs.filter((plan) => plan.delta.reroutedSessionCount > 0).map(toRebuiltLeave)).toEqual([]);
            });
        });
    }
);

describe.each(MEASURED_ROOMS)('a single leave from $room is planned without hanging', ({ options, memberCount }) => {
    // The remaining members' browsers report RTT for the pairs they select, so the planner holds a sparse measured graph.
    const formed = computeRtcTopologyFixturePlan({
        options,
        group: createRtcTopologyFixtureGroup(memberCount),
        previous: undefined
    }).snapshot;

    it.each(formed.activeSessionIds)('the leave of %s is repaired in place, the leaver gone and the rest connected inside the limit', (leaverSessionId) => {
        const planned = computeRtcTopologyFixtureMeasuredLeave({ options, formed, leaverSessionIds: [leaverSessionId], rttReportingDegreeLimit: 5 });

        expect(planned.derivation).toEqual({ method: 'incremental' });
        expect(isValidLeaveLayout(planned.snapshot, [leaverSessionId])).toBe(true);
    }, MEASURED_LEAVE_TIMEOUT_MS);
});

describe('two linked members leaving a measured 20-member mesh in one plan', () => {
    // The remaining members' browsers report RTT for the pairs they select, as for a single measured leave.
    const formed = computeRtcTopologyFixturePlan({
        options: RTC_TOPOLOGY_MESH_OPTIONS,
        group: createRtcTopologyFixtureGroup(20),
        previous: undefined
    }).snapshot;
    const linkedPairs = formed.activeSessionIds.flatMap((first) =>
        (formed.nextHopsBySessionId[first] ?? []).filter((second) => first < second).map((second) => [first, second] as const)
    );

    it('the formed mesh has every link of the unmeasured sweep\'s mesh of twenty', () => {
        expect(linkedPairs).toHaveLength(37);
    });

    it.each(linkedPairs)('the leave of %s and %s is repaired in place, both gone and the rest connected inside the limit', (first, second) => {
        const planned = computeRtcTopologyFixtureMeasuredLeave({
            options: RTC_TOPOLOGY_MESH_OPTIONS,
            formed,
            leaverSessionIds: [first, second],
            rttReportingDegreeLimit: 5
        });

        expect(planned.derivation).toEqual({ method: 'incremental' });
        expect(isValidLeaveLayout(planned.snapshot, [first, second])).toBe(true);
    }, MEASURED_LEAVE_TIMEOUT_MS);
});

describe('the leave layout check of the sweep', () => {
    // Each layout breaks exactly one clause of the check, with peer-4 as the leaver.
    it.each<{ readonly layout: string; readonly planned: RtcTopologyFixtureLayout; }>([
        {
            layout: 'still links the leaver',
            planned: {
                activeSessionIds: ['peer-1', 'peer-2', 'peer-3'],
                nextHopsBySessionId: { 'peer-1': ['peer-2'], 'peer-2': ['peer-1', 'peer-3'], 'peer-3': ['peer-2', 'peer-4'], 'peer-4': ['peer-3'] },
                degreeLimit: 2
            }
        },
        {
            layout: 'gives a member more links than the degree limit',
            planned: {
                activeSessionIds: ['peer-1', 'peer-2', 'peer-3'],
                nextHopsBySessionId: { 'peer-1': ['peer-2', 'peer-3'], 'peer-2': ['peer-1'], 'peer-3': ['peer-1'] },
                degreeLimit: 1
            }
        },
        {
            layout: 'links a pair one way only',
            planned: {
                activeSessionIds: ['peer-1', 'peer-2', 'peer-3'],
                nextHopsBySessionId: { 'peer-1': ['peer-2', 'peer-3'], 'peer-2': ['peer-1'], 'peer-3': [] },
                degreeLimit: 2
            }
        },
        {
            layout: 'leaves a member unreachable',
            planned: {
                activeSessionIds: ['peer-1', 'peer-2', 'peer-3'],
                nextHopsBySessionId: { 'peer-1': ['peer-2'], 'peer-2': ['peer-1'], 'peer-3': [] },
                degreeLimit: 2
            }
        },
        {
            layout: 'keeps next hops for the leaver that nobody lists back',
            planned: {
                activeSessionIds: ['peer-1', 'peer-2', 'peer-3'],
                nextHopsBySessionId: { 'peer-1': ['peer-2'], 'peer-2': ['peer-1', 'peer-3'], 'peer-3': ['peer-2'], 'peer-4': ['peer-3'] },
                degreeLimit: 2
            }
        },
        {
            layout: 'links a member both ways to a session that is no member',
            planned: {
                activeSessionIds: ['peer-1', 'peer-2', 'peer-3'],
                nextHopsBySessionId: { 'peer-1': ['peer-2'], 'peer-2': ['peer-1', 'peer-3'], 'peer-3': ['peer-2', 'peer-9'], 'peer-9': ['peer-3'] },
                degreeLimit: 2
            }
        }
    ])('rejects a layout that $layout', ({ planned }) => {
        expect(isValidLeaveLayout(planned, ['peer-4'])).toBe(false);
    });
});

type SweepEvent = (typeof SWEEP_EVENTS)[number];

interface SweptPlan {
    readonly event: SweepEvent;
    /** None for the join, one for a leave. */
    readonly leaverSessionIds: readonly string[];
    readonly derivation: RtcTopologyPlanDerivation;
    readonly delta: TopologyLayoutDelta;
    readonly planned: RallarOverlayTopologySnapshot;
    readonly heldReshapeReasons: readonly HeldTopologyReshapeReason[];
}

/**
 * Every single leave, one join, and every single leave with one join in the same plan, from the formed room; the
 * replans plan with the reshape permission given, or without the reshape gate when none is.
 */
function computeRoomSweep(
    room: Pick<RtcTopologyFixtureLeaveInput, 'options' | 'memberCount' | 'directorJoins'>,
    reshape?: TopologyReshapePermission
): readonly SweptPlan[] {
    const formed = computeRtcTopologyFixturePlan({
        options: room.options,
        group: createRtcTopologyFixtureGroup(room.memberCount),
        previous: undefined
    }).snapshot;
    const grown = createRtcTopologyFixtureGroup(room.memberCount + 1);
    const joined = computeRtcTopologyFixturePlan({
        options: room.options,
        group: room.directorJoins === true ? toRtcTopologyGroupWithDirector(grown, `peer-${room.memberCount + 1}`) : grown,
        previous: formed,
        reshape
    });
    const leaves = formed.activeSessionIds.flatMap((leaverSessionId) =>
        ([0, 1] as const).map((joinerCount) => {
            const left = computeRtcTopologyFixtureLeave({ ...room, leaver: leaverSessionId, joinerCount, reshape });
            return toSweptPlan(joinerCount === 0 ? 'leave' : 'leave-and-join', [leaverSessionId], left);
        })
    );
    return [toSweptPlan('join', [], { previous: formed, planned: joined }), ...leaves];
}

function toSweptPlan(event: SweepEvent, leaverSessionIds: readonly string[], replan: RtcTopologyFixtureReplan): SweptPlan {
    return {
        event,
        leaverSessionIds,
        derivation: replan.planned.derivation,
        delta: computeTopologyLayoutDelta(replan.previous, replan.planned.snapshot),
        planned: replan.planned.snapshot,
        heldReshapeReasons: replan.planned.heldReshapeReasons
    };
}

interface SweptDeparture extends Pick<SweptPlan, 'leaverSessionIds' | 'derivation' | 'delta' | 'planned'> {
    /** The formed layout links the two leavers. */
    readonly linked: boolean;
}

/** Every pair of the formed members leaving in the same plan, with nobody joining. */
function computeRoomPairSweep(room: Pick<RtcTopologyFixtureLeaveInput, 'options' | 'memberCount'>): readonly SweptDeparture[] {
    const formed = computeRtcTopologyFixturePlan({
        options: room.options,
        group: createRtcTopologyFixtureGroup(room.memberCount),
        previous: undefined
    }).snapshot;
    return formed.activeSessionIds.flatMap((first, index) =>
        formed.activeSessionIds.slice(index + 1).map((second) => {
            const planned = computeRtcTopologyFixtureDeparture({ options: room.options, formed, leaverSessionIds: [first, second] });
            return {
                leaverSessionIds: [first, second],
                linked: (formed.nextHopsBySessionId[first] ?? []).includes(second),
                derivation: planned.derivation,
                delta: computeTopologyLayoutDelta(formed, planned.snapshot),
                planned: planned.snapshot
            };
        })
    );
}

/** A plan named by its leavers and how the planner derived it, so a failure says which leave and why. */
function toRebuiltLeave(plan: Pick<SweptPlan, 'leaverSessionIds' | 'derivation'>): string {
    const reason = plan.derivation.method === 'rebuilt' ? plan.derivation.reason : plan.derivation.method;
    return `${plan.leaverSessionIds.join(' + ')}: ${reason}`;
}

/**
 * No leaver is a member, every session the next hops name or list is a member, and every link is two-way, inside the
 * limit, and connects all members.
 */
function isValidLeaveLayout(planned: RtcTopologyFixtureLayout, leaverSessionIds: readonly string[]): boolean {
    const isMember = (sessionId: string) => planned.activeSessionIds.includes(sessionId);
    return leaverSessionIds.length > 0 &&
        !leaverSessionIds.some(isMember) &&
        Object.entries(planned.nextHopsBySessionId).every(([sessionId, nextHops]) => isMember(sessionId) && nextHops.every(isMember)) &&
        isConnectedRtcTopologyFixtureLayout(planned);
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
