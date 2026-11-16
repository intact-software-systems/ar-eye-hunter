import {
    computeTopologyChurnReport,
    type TopologyChurnPhaseReport,
    type TopologyChurnPhaseWindow,
    type TopologyChurnPromotionSighting
} from '@shared-test/black-box-runner/topology-churn/compute-topology-churn-report.ts';
import type { AdminRoomTopologyPlan } from '@shared/api/admin-rooms/admin-room-topology-plans.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { isEmptyTopologyLayoutDelta } from '@shared/api/topology-plan/is-empty-topology-layout-delta.ts';
import type {
    ReplacedTopologyLayout,
    TopologyLayoutDelta,
    TopologyReplanCause
} from '@shared/api/topology-plan/rtc-topology-plan-record.ts';
import {
    TOPOLOGY_RESHAPE_REASONS,
    type TopologyPlanChange
} from '@shared/api/topology-plan/topology-plan-change.ts';
import { describe, expect, it } from 'vitest';

const OVERLAP_MS = 7_500;

const FORMATION: TopologyChurnPhaseWindow = {
    name: 'formation',
    startedAtEpochMs: 0,
    endedAtEpochMs: 60_000,
    joinCount: 4,
    leaveCount: 0
};

interface TestPlanInput {
    readonly version: number;
    readonly plannedAtEpochMs: number;
    readonly replacedAgeMs?: number | null;
    readonly causes?: readonly TopologyReplanCause[];
    readonly delta?: Partial<TopologyLayoutDelta>;
    readonly change?: TopologyPlanChange;
    readonly longestPathHops?: number;
    readonly degreeLimit?: number;
}

function toLayout(version: number): GroupLayoutIdentity {
    return { groupRevision: version, presenceRevision: 0, version, state: 'active' };
}

function toReplaced(version: number, ageMs: number | null): ReplacedTopologyLayout | null {
    return ageMs === null ? null : { layout: toLayout(version - 1), ageMs };
}

function createPlan(input: TestPlanInput): AdminRoomTopologyPlan {
    const delta: TopologyLayoutDelta = {
        joinedSessionCount: 0,
        leftSessionCount: 0,
        changedSessionCount: 1,
        reroutedSessionCount: 0,
        acceptingSessionCount: 0,
        maxJoinerEdgesPerSession: 0,
        ...input.delta
    };
    return {
        publicationId: `publication-${input.version}`,
        requestedAtEpochMs: input.plannedAtEpochMs,
        layout: toLayout(input.version),
        topology: 'mesh',
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

function createRemoval(version: number, requestedAtEpochMs: number): AdminRoomTopologyPlan {
    return { ...createPlan({ version, plannedAtEpochMs: requestedAtEpochMs }), plan: null };
}

function computeFormation(
    plans: readonly AdminRoomTopologyPlan[],
    sightings: readonly TopologyChurnPromotionSighting[] = []
): TopologyChurnPhaseReport {
    const report = computeTopologyChurnReport({
        plans,
        sightings,
        phases: [FORMATION],
        replacedLayoutOverlapMs: OVERLAP_MS
    });
    return report.phases[0];
}

const IDENTITY_ONLY: Partial<TopologyLayoutDelta> = { changedSessionCount: 0 };

describe('computeTopologyChurnReport', () => {
    it('counts plans per minute within each phase\'s window', () => {
        const churn: TopologyChurnPhaseWindow = {
            name: 'churn',
            startedAtEpochMs: 60_000,
            endedAtEpochMs: 180_000,
            joinCount: 6,
            leaveCount: 5
        };
        const emptyChurn: TopologyChurnPhaseWindow = { ...churn, startedAtEpochMs: 180_000 };
        const report = computeTopologyChurnReport({
            plans: [
                createPlan({ version: 1, plannedAtEpochMs: 0 }),
                createRemoval(2, 10_000),
                createPlan({ version: 3, plannedAtEpochMs: 30_000 }),
                createPlan({ version: 4, plannedAtEpochMs: 59_999 }),
                createPlan({ version: 5, plannedAtEpochMs: 60_000 }),
                createPlan({ version: 6, plannedAtEpochMs: 120_000 }),
                createPlan({ version: 7, plannedAtEpochMs: 180_000 })
            ],
            sightings: [],
            phases: [FORMATION, churn, emptyChurn],
            replacedLayoutOverlapMs: OVERLAP_MS
        });

        const [formation, churnPhase, emptyPhase] = report.phases;
        // Formation [0, 60 000): plans at 0, 30 000 and 59 999; the removal at 10 000 is not a plan.
        // 3 plans × 60 000 / 60 000 ms = 3 per minute.
        expect(formation).toMatchObject({ phase: 'formation', durationMs: 60_000, joinCount: 4, leaveCount: 0 });
        expect(formation.planCount).toBe(3);
        expect(formation.plansPerMinute).toBe(3);
        // Churn [60 000, 180 000): plans at 60 000 and 120 000; 180 000 is past the exclusive end.
        // 2 plans × 60 000 / 120 000 ms = 1 per minute.
        expect(churnPhase).toMatchObject({ phase: 'churn', durationMs: 120_000, joinCount: 6, leaveCount: 5 });
        expect(churnPhase.planCount).toBe(2);
        expect(churnPhase.plansPerMinute).toBe(1);
        // A window of zero duration holds no plan and has no rate.
        expect(emptyPhase.durationMs).toBe(0);
        expect(emptyPhase.planCount).toBe(0);
        expect(emptyPhase.plansPerMinute).toBeNull();
        expect(emptyPhase.promotionsPerMinute).toBeNull();
        // The plan at 180 000 lies in no phase's window.
        expect(report.outsidePhasesPlanCount).toBe(1);
    });

    it('counts the plans planned before the first phase or after the last, and no removal', () => {
        const report = computeTopologyChurnReport({
            plans: [
                createPlan({ version: 1, plannedAtEpochMs: -1 }),
                createPlan({ version: 2, plannedAtEpochMs: 0 }),
                createPlan({ version: 3, plannedAtEpochMs: 59_999 }),
                createPlan({ version: 4, plannedAtEpochMs: 60_000 }),
                createRemoval(5, 90_000)
            ],
            sightings: [],
            phases: [FORMATION],
            replacedLayoutOverlapMs: OVERLAP_MS
        });

        expect(report.phases[0].planCount).toBe(2);
        expect(report.outsidePhasesPlanCount).toBe(2);
    });

    it('counts a plan inside the overlap when the layout it replaced was younger than the served overlap', () => {
        const phase = computeFormation([
            createPlan({ version: 1, plannedAtEpochMs: 1_000, replacedAgeMs: 1_000 }),
            createPlan({ version: 2, plannedAtEpochMs: 2_000, replacedAgeMs: 7_499 }),
            createPlan({ version: 3, plannedAtEpochMs: 3_000, replacedAgeMs: 7_500 }),
            createPlan({ version: 4, plannedAtEpochMs: 4_000, replacedAgeMs: 20_000 })
        ]);

        // Ages 1 000 and 7 499 are below the 7 500 ms overlap; 7 500 is not below it.
        // Share: 2 inside of 4 plans that replaced a layout = 0.5.
        expect(phase.insideOverlapPlanCount).toBe(2);
        expect(phase.insideOverlapShare).toBe(0.5);
    });

    it('does not count a first layout towards the overlap share', () => {
        const phase = computeFormation([
            createPlan({ version: 1, plannedAtEpochMs: 1_000, replacedAgeMs: null }),
            createPlan({ version: 2, plannedAtEpochMs: 2_000, replacedAgeMs: 1_000 }),
            createPlan({ version: 3, plannedAtEpochMs: 3_000, replacedAgeMs: 9_000 })
        ]);
        const firstOnly = computeFormation([createPlan({ version: 1, plannedAtEpochMs: 1_000, replacedAgeMs: null })]);

        // The first layout replaced nothing: 1 inside of 2 replacing plans = 0.5, not 1 of 3.
        expect(phase.planCount).toBe(3);
        expect(phase.insideOverlapPlanCount).toBe(1);
        expect(phase.insideOverlapShare).toBe(0.5);
        // No plan replaced a layout: the share has no denominator.
        expect(firstOnly.insideOverlapPlanCount).toBe(0);
        expect(firstOnly.insideOverlapShare).toBeNull();
    });

    it('separates identity-only plans from edge-changing ones', () => {
        // Input in storage order, not time order: the hop figures read plannedAtEpochMs order.
        const phase = computeFormation([
            createPlan({
                version: 4,
                plannedAtEpochMs: 4_000,
                delta: { changedSessionCount: 6, reroutedSessionCount: 3, joinedSessionCount: 2, maxJoinerEdgesPerSession: 2 },
                longestPathHops: 4,
                degreeLimit: 4
            }),
            createPlan({ version: 1, plannedAtEpochMs: 1_000, delta: IDENTITY_ONLY, longestPathHops: 9 }),
            createPlan({
                version: 2,
                plannedAtEpochMs: 2_000,
                delta: { changedSessionCount: 2, reroutedSessionCount: 1, joinedSessionCount: 1, maxJoinerEdgesPerSession: 1 },
                longestPathHops: 3
            }),
            createPlan({
                version: 3,
                plannedAtEpochMs: 3_000,
                delta: { changedSessionCount: 4, leftSessionCount: 1 },
                longestPathHops: 5
            })
        ]);

        expect(phase.planCount).toBe(4);
        expect(phase.identityOnlyPlanCount).toBe(1);
        // Changed over the three edge-changing plans, ascending [2, 4, 6]:
        // median = rank ceil(0.5 × 3) = 2 → 4; p90 = rank ceil(0.9 × 3) = 3 → 6.
        expect(phase.changedSessionsPerPlan).toEqual({ min: 2, median: 4, p90: 6, max: 6 });
        // Rerouted ascending [0, 1, 3]: median rank 2 → 1, p90 rank 3 → 3.
        expect(phase.reroutedSessionsPerPlan).toEqual({ min: 0, median: 1, p90: 3, max: 3 });
        // Joined ascending [0, 1, 2]: median rank 2 → 1, p90 rank 3 → 2.
        expect(phase.joinersPerPlan).toEqual({ min: 0, median: 1, p90: 2, max: 2 });
        // Edge-changing plans in time order hop 3, 5, 4; the identity-only plan's 9 is not a layout change.
        expect(phase.longestPathHops).toEqual({ first: 3, last: 4, max: 5 });
        expect(phase.maxJoinerEdgesPerSession).toBe(2);
        // Limits 4, 3, 3, 3: the largest limit a plan of the phase worked under.
        expect(phase.degreeLimit).toBe(4);
    });

    it('reports the share of joins and leaves that rerouted a member they did not involve', () => {
        const phase = computeFormation([
            createPlan({ version: 1, plannedAtEpochMs: 1_000, causes: ['join'], delta: { reroutedSessionCount: 2 } }),
            createPlan({ version: 2, plannedAtEpochMs: 2_000, causes: ['join'], delta: { reroutedSessionCount: 0 } }),
            createPlan({ version: 3, plannedAtEpochMs: 3_000, causes: ['leave'], delta: { reroutedSessionCount: 1 } }),
            createPlan({ version: 4, plannedAtEpochMs: 4_000, causes: ['rtt'], delta: { reroutedSessionCount: 5 } }),
            createPlan({ version: 5, plannedAtEpochMs: 5_000, causes: ['join', 'rtt'], delta: { reroutedSessionCount: 0 } })
        ]);

        // Membership plans: versions 1, 2, 3 and 5. Rerouting among them: versions 1 and 3.
        // The rtt-only plan's reroute is not a membership reroute. Share 2 / 4 = 0.5.
        expect(phase.reroutingMembershipPlanCount).toBe(2);
        expect(phase.reroutingMembershipPlanShare).toBe(0.5);
    });

    it('matches sightings to plans by layout identity and reports the lag', () => {
        const removedTwin: GroupLayoutIdentity = { ...toLayout(3), state: 'removed' };
        const phase = computeFormation(
            [
                createPlan({ version: 1, plannedAtEpochMs: 1_000 }),
                createPlan({ version: 2, plannedAtEpochMs: 2_000 }),
                createPlan({ version: 3, plannedAtEpochMs: 3_000 })
            ],
            [
                { layout: toLayout(1), firstSeenAtEpochMs: 1_250 },
                { layout: toLayout(2), firstSeenAtEpochMs: 1_900 },
                { layout: removedTwin, firstSeenAtEpochMs: 3_100 },
                { layout: toLayout(9), firstSeenAtEpochMs: 4_000 }
            ]
        );

        // Version 3's only sighting differs in state, and version 9 has no plan: two promoted plans.
        // 2 × 60 000 / 60 000 ms = 2 per minute.
        expect(phase.promotedPlanCount).toBe(2);
        expect(phase.promotionsPerMinute).toBe(2);
        // Lags: 1 250 − 1 000 = 250; 1 900 − 2 000 = −100, clamped to 0. Ascending [0, 250]:
        // median = rank ceil(0.5 × 2) = 1 → 0; p90 = rank ceil(0.9 × 2) = 2 → 250.
        expect(phase.promotionLagMs).toEqual({ min: 0, median: 0, p90: 250, max: 250 });
    });

    it('counts plans by cause, and a plan with two causes under both', () => {
        const phase = computeFormation([
            createPlan({ version: 1, plannedAtEpochMs: 1_000, causes: ['join'] }),
            createPlan({ version: 2, plannedAtEpochMs: 2_000, causes: ['join', 'leave'] }),
            createPlan({ version: 3, plannedAtEpochMs: 3_000, causes: ['rtt'] }),
            createPlan({ version: 4, plannedAtEpochMs: 4_000, causes: [] })
        ]);

        // join: versions 1 and 2; leave: version 2; rtt: version 3; version 4 names no cause.
        expect(phase.plansByCause).toEqual({ join: 2, leave: 1, 'leader-change': 0, config: 0, rtt: 1 });
        expect(phase.uncausedPlanCount).toBe(1);
    });

    it('reports null distributions for a phase without an edge-changing plan', () => {
        const phase = computeFormation([
            createPlan({ version: 1, plannedAtEpochMs: 1_000, replacedAgeMs: null, causes: ['rtt'], delta: IDENTITY_ONLY }),
            createPlan({ version: 2, plannedAtEpochMs: 2_000, replacedAgeMs: null, causes: ['config'], delta: IDENTITY_ONLY })
        ]);

        expect(phase.planCount).toBe(2);
        expect(phase.identityOnlyPlanCount).toBe(2);
        expect(phase.changedSessionsPerPlan).toBeNull();
        expect(phase.reroutedSessionsPerPlan).toBeNull();
        expect(phase.joinersPerPlan).toBeNull();
        expect(phase.longestPathHops).toBeNull();
        // No sighting, no replaced layout and no join or leave: each figure over an empty set is null.
        expect(phase.promotionLagMs).toBeNull();
        expect(phase.insideOverlapShare).toBeNull();
        expect(phase.reroutingMembershipPlanShare).toBeNull();
        expect(phase.maxJoinerEdgesPerSession).toBe(0);
    });

    it('counts plans and promoted plans by kind', () => {
        const phase = computeFormation(
            [
                createPlan({ version: 1, plannedAtEpochMs: 1_000 }),
                createPlan({ version: 2, plannedAtEpochMs: 2_000 }),
                createPlan({ version: 3, plannedAtEpochMs: 3_000 }),
                createPlan({ version: 4, plannedAtEpochMs: 4_000, change: { kind: 'repair' } }),
                createPlan({ version: 5, plannedAtEpochMs: 5_000, change: { kind: 'repair' } }),
                createPlan({ version: 6, plannedAtEpochMs: 6_000, change: { kind: 'reshape', reason: 'refinement' } })
            ],
            [
                { layout: toLayout(1), firstSeenAtEpochMs: 1_100 },
                { layout: toLayout(3), firstSeenAtEpochMs: 3_100 },
                { layout: toLayout(5), firstSeenAtEpochMs: 5_100 }
            ]
        );

        expect(phase.plansByKind).toEqual({ attach: 3, repair: 2, reshape: 1 });
        // Promoted: versions 1 and 3 (attaches) and 5 (a repair); the reshape was never seen.
        expect(phase.promotedPlansByKind).toEqual({ attach: 2, repair: 1, reshape: 0 });
        expect(phase.promotedPlanCount).toBe(3);
    });

    it('counts reshapes by reason, with every reason present at zero', () => {
        const phase = computeFormation([
            createPlan({ version: 1, plannedAtEpochMs: 1_000, change: { kind: 'reshape', reason: 'refinement' } }),
            createPlan({ version: 2, plannedAtEpochMs: 2_000, change: { kind: 'reshape', reason: 'refinement' } }),
            createPlan({ version: 3, plannedAtEpochMs: 3_000, change: { kind: 'reshape', reason: 'kind-change' } }),
            createPlan({ version: 4, plannedAtEpochMs: 4_000 })
        ]);

        expect(Object.keys(phase.reshapesByReason).sort()).toEqual([...TOPOLOGY_RESHAPE_REASONS].sort());
        expect(phase.reshapesByReason.refinement).toBe(2);
        expect(phase.reshapesByReason['kind-change']).toBe(1);
        expect(Object.values(phase.reshapesByReason).reduce((sum, count) => sum + count, 0)).toBe(3);
    });

    it('an identity-only plan belongs to no kind', () => {
        const phase = computeFormation([
            createPlan({ version: 1, plannedAtEpochMs: 1_000, delta: IDENTITY_ONLY, causes: ['rtt'] }),
            createPlan({ version: 2, plannedAtEpochMs: 2_000 })
        ]);

        expect(phase.planCount).toBe(2);
        expect(phase.identityOnlyPlanCount).toBe(1);
        expect(phase.plansByKind).toEqual({ attach: 1, repair: 0, reshape: 0 });
    });

    it('reports what a reshape rerouted against what an attach or a repair did', () => {
        const reshape = (version: number, reroutedSessionCount: number): AdminRoomTopologyPlan =>
            createPlan({
                version,
                plannedAtEpochMs: version * 1_000,
                delta: { reroutedSessionCount },
                change: { kind: 'reshape', reason: 'leader-rooting' }
            });
        const phase = computeFormation([
            reshape(1, 2),
            reshape(2, 5),
            reshape(3, 8),
            createPlan({ version: 4, plannedAtEpochMs: 4_000 }),
            createPlan({ version: 5, plannedAtEpochMs: 5_000, change: { kind: 'repair' } })
        ]);
        const withoutReshape = computeFormation([createPlan({ version: 1, plannedAtEpochMs: 1_000 })]);

        // Reroutes over the three reshapes, ascending [2, 5, 8]: median rank 2 → 5, p90 rank 3 → 8.
        expect(phase.reroutedSessionsPerReshape).toEqual({ min: 2, median: 5, p90: 8, max: 8 });
        expect(phase.reroutingPlansByKind).toEqual({ attach: 0, repair: 0, reshape: 3 });
        expect(withoutReshape.reroutedSessionsPerReshape).toBeNull();
    });

    it('counts, per kind, the plans that rerouted a member they did not involve', () => {
        const phase = computeFormation([
            createPlan({ version: 1, plannedAtEpochMs: 1_000, delta: { reroutedSessionCount: 1 } }),
            createPlan({ version: 2, plannedAtEpochMs: 2_000 }),
            createPlan({ version: 3, plannedAtEpochMs: 3_000, change: { kind: 'repair' }, delta: { reroutedSessionCount: 2 } }),
            createPlan({ version: 4, plannedAtEpochMs: 4_000, change: { kind: 'repair' }, delta: { reroutedSessionCount: 4 } }),
            createPlan({ version: 5, plannedAtEpochMs: 5_000, change: { kind: 'repair' } }),
            createPlan({
                version: 6,
                plannedAtEpochMs: 6_000,
                change: { kind: 'reshape', reason: 'delta-too-large' },
                delta: { reroutedSessionCount: 3 }
            })
        ]);

        expect(phase.plansByKind).toEqual({ attach: 2, repair: 3, reshape: 1 });
        expect(phase.reroutingPlansByKind).toEqual({ attach: 1, repair: 2, reshape: 1 });
    });
});
