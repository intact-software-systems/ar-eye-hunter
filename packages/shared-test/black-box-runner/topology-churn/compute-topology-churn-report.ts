import type { AdminRoomTopologyPlan } from '@shared/api/admin-rooms/admin-room-topology-plans.ts';
import {
    isSameGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type {
    RtcTopologyPlanRecord,
    TopologyReplanCause
} from '@shared/api/topology-plan/rtc-topology-plan-record.ts';
import { computeNearestRank } from '@shared/measurement/compute-nearest-rank.ts';

export interface TopologyChurnPhaseWindow {
    readonly name: 'formation' | 'churn';
    readonly startedAtEpochMs: number;
    readonly endedAtEpochMs: number;
    readonly joinCount: number;
    readonly leaveCount: number;
}

export interface TopologyChurnPromotionSighting {
    readonly layout: GroupLayoutIdentity;
    readonly firstSeenAtEpochMs: number;
}

export interface ComputeTopologyChurnReportInput {
    readonly plans: readonly AdminRoomTopologyPlan[];
    readonly sightings: readonly TopologyChurnPromotionSighting[];
    readonly phases: readonly TopologyChurnPhaseWindow[];
    readonly replacedLayoutOverlapMs: number;
}

export interface TopologyChurnDistribution {
    readonly min: number;
    readonly median: number;
    readonly p90: number;
    readonly max: number;
}

export interface TopologyChurnLongestPathHops {
    readonly first: number;
    readonly last: number;
    readonly max: number;
}

/** Rates and shares are null when their denominator is 0; distributions are null over no values. */
export interface TopologyChurnPhaseReport {
    readonly phase: TopologyChurnPhaseWindow['name'];
    readonly durationMs: number;
    readonly joinCount: number;
    readonly leaveCount: number;
    readonly planCount: number;
    readonly plansPerMinute: number | null;
    readonly promotedPlanCount: number;
    readonly promotionsPerMinute: number | null;
    readonly promotionLagMs: TopologyChurnDistribution | null;
    readonly insideOverlapPlanCount: number;
    readonly insideOverlapShare: number | null;
    readonly identityOnlyPlanCount: number;
    readonly changedSessionsPerPlan: TopologyChurnDistribution | null;
    readonly reroutedSessionsPerPlan: TopologyChurnDistribution | null;
    readonly joinersPerPlan: TopologyChurnDistribution | null;
    readonly reroutingMembershipPlanCount: number;
    readonly reroutingMembershipPlanShare: number | null;
    readonly maxJoinerEdgesPerSession: number;
    readonly degreeLimit: number | null;
    readonly plansByCause: Record<TopologyReplanCause, number>;
    readonly uncausedPlanCount: number;
    readonly longestPathHops: TopologyChurnLongestPathHops | null;
}

export interface TopologyChurnReport {
    readonly phases: readonly TopologyChurnPhaseReport[];
}

interface RecordedTopologyPlan {
    readonly layout: GroupLayoutIdentity;
    readonly degreeLimit: number;
    readonly record: RtcTopologyPlanRecord;
}

interface ComputePhaseFiguresInput {
    readonly plans: readonly RecordedTopologyPlan[];
    readonly durationMs: number;
    readonly sightings: readonly TopologyChurnPromotionSighting[];
    readonly replacedLayoutOverlapMs: number;
}

const MS_PER_MINUTE = 60_000;

export function computeTopologyChurnReport(input: ComputeTopologyChurnReportInput): TopologyChurnReport {
    const plans = input.plans
        .flatMap(toRecordedTopologyPlan)
        .sort((left, right) => left.record.plannedAtEpochMs - right.record.plannedAtEpochMs);
    return {
        phases: input.phases.map((phase) => {
            const durationMs = phase.endedAtEpochMs - phase.startedAtEpochMs;
            const figures: ComputePhaseFiguresInput = {
                plans: plans.filter((plan) => isWithinPhase(plan, phase)),
                durationMs,
                sightings: input.sightings,
                replacedLayoutOverlapMs: input.replacedLayoutOverlapMs
            };
            return {
                phase: phase.name,
                durationMs,
                joinCount: phase.joinCount,
                leaveCount: phase.leaveCount,
                planCount: figures.plans.length,
                plansPerMinute: computePerMinute(figures.plans.length, durationMs),
                ...computePromotionFigures(figures),
                ...computeOverlapFigures(figures),
                ...computeEdgeFigures(figures.plans),
                ...computeCauseFigures(figures.plans)
            };
        })
    };
}

function toRecordedTopologyPlan(entry: AdminRoomTopologyPlan): RecordedTopologyPlan[] {
    return entry.plan === null ? [] : [{ layout: entry.layout, degreeLimit: entry.degreeLimit, record: entry.plan }];
}

function isWithinPhase(plan: RecordedTopologyPlan, phase: TopologyChurnPhaseWindow): boolean {
    return plan.record.plannedAtEpochMs >= phase.startedAtEpochMs &&
        plan.record.plannedAtEpochMs < phase.endedAtEpochMs;
}

function computePromotionFigures(
    input: ComputePhaseFiguresInput
): Pick<TopologyChurnPhaseReport, 'promotedPlanCount' | 'promotionsPerMinute' | 'promotionLagMs'> {
    const lagsMs = input.plans.flatMap((plan) => {
        const sighting = input.sightings.find((candidate) => isSameGroupLayoutIdentity(candidate.layout, plan.layout));
        return sighting === undefined ? [] : [Math.max(0, sighting.firstSeenAtEpochMs - plan.record.plannedAtEpochMs)];
    });
    return {
        promotedPlanCount: lagsMs.length,
        promotionsPerMinute: computePerMinute(lagsMs.length, input.durationMs),
        promotionLagMs: computeDistribution(lagsMs)
    };
}

function computeOverlapFigures(
    input: ComputePhaseFiguresInput
): Pick<TopologyChurnPhaseReport, 'insideOverlapPlanCount' | 'insideOverlapShare'> {
    const replacedAgesMs = input.plans.flatMap((plan) =>
        plan.record.replaced === null ? [] : [plan.record.replaced.ageMs]
    );
    const insideOverlapPlanCount = replacedAgesMs.filter((ageMs) => ageMs < input.replacedLayoutOverlapMs).length;
    return {
        insideOverlapPlanCount,
        insideOverlapShare: computeShare(insideOverlapPlanCount, replacedAgesMs.length)
    };
}

function computeEdgeFigures(plans: readonly RecordedTopologyPlan[]): Pick<
    TopologyChurnPhaseReport,
    | 'identityOnlyPlanCount'
    | 'changedSessionsPerPlan'
    | 'reroutedSessionsPerPlan'
    | 'joinersPerPlan'
    | 'maxJoinerEdgesPerSession'
    | 'degreeLimit'
    | 'longestPathHops'
> {
    const edgeChanging = plans.map((plan) => plan.record).filter((record) => !isIdentityOnly(record));
    return {
        identityOnlyPlanCount: plans.length - edgeChanging.length,
        changedSessionsPerPlan: computeDistribution(edgeChanging.map((record) => record.delta.changedSessionCount)),
        reroutedSessionsPerPlan: computeDistribution(edgeChanging.map((record) => record.delta.reroutedSessionCount)),
        joinersPerPlan: computeDistribution(edgeChanging.map((record) => record.delta.joinedSessionCount)),
        maxJoinerEdgesPerSession: Math.max(0, ...plans.map((plan) => plan.record.delta.maxJoinerEdgesPerSession)),
        degreeLimit: plans.length === 0 ? null : Math.max(...plans.map((plan) => plan.degreeLimit)),
        longestPathHops: computeLongestPathHops(edgeChanging)
    };
}

function isIdentityOnly(record: RtcTopologyPlanRecord): boolean {
    return Object.values(record.delta).every((count) => count === 0);
}

function computeLongestPathHops(
    timeOrderedRecords: readonly RtcTopologyPlanRecord[]
): TopologyChurnLongestPathHops | null {
    const hops = timeOrderedRecords.map((record) => record.longestPathHops);
    if (hops.length === 0) {
        return null;
    }
    return { first: hops[0], last: hops[hops.length - 1], max: Math.max(...hops) };
}

function computeCauseFigures(
    plans: readonly RecordedTopologyPlan[]
): Pick<
    TopologyChurnPhaseReport,
    'plansByCause' | 'uncausedPlanCount' | 'reroutingMembershipPlanCount' | 'reroutingMembershipPlanShare'
> {
    const records = plans.map((plan) => plan.record);
    const membershipRecords = records.filter((record) =>
        record.causes.includes('join') || record.causes.includes('leave')
    );
    const reroutingMembershipPlanCount = membershipRecords.filter((record) => record.delta.reroutedSessionCount > 0)
        .length;
    return {
        plansByCause: computePlansByCause(records),
        uncausedPlanCount: records.filter((record) => record.causes.length === 0).length,
        reroutingMembershipPlanCount,
        reroutingMembershipPlanShare: computeShare(reroutingMembershipPlanCount, membershipRecords.length)
    };
}

function computePlansByCause(records: readonly RtcTopologyPlanRecord[]): Record<TopologyReplanCause, number> {
    const countPlans = (cause: TopologyReplanCause): number =>
        records.filter((record) => record.causes.includes(cause)).length;
    return {
        join: countPlans('join'),
        leave: countPlans('leave'),
        'leader-change': countPlans('leader-change'),
        config: countPlans('config'),
        rtt: countPlans('rtt')
    };
}

function computePerMinute(count: number, durationMs: number): number | null {
    return durationMs > 0 ? (count * MS_PER_MINUTE) / durationMs : null;
}

function computeShare(count: number, total: number): number | null {
    return total > 0 ? count / total : null;
}

function computeDistribution(values: readonly number[]): TopologyChurnDistribution | null {
    const median = computeNearestRank(values, 0.5);
    const p90 = computeNearestRank(values, 0.9);
    if (median === undefined || p90 === undefined) {
        return null;
    }
    return { min: Math.min(...values), median, p90, max: Math.max(...values) };
}
