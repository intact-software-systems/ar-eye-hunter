import type { AdminRoomTopologyPlan } from '@shared/api/admin-rooms/admin-room-topology-plans.ts';
import {
    isSameGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { isEmptyTopologyLayoutDelta } from '@shared/api/topology-plan/is-empty-topology-layout-delta.ts';
import {
    TOPOLOGY_REPLAN_CAUSES,
    type RtcTopologyPlanRecord,
    type TopologyReplanCause
} from '@shared/api/topology-plan/rtc-topology-plan-record.ts';
import { computeNearestRank } from '@shared/measurement/compute-nearest-rank.ts';
import { computeNumberExtrema } from '@shared/measurement/compute-number-extrema.ts';

import { computeCountsByKey } from './compute-counts-by-key.ts';
import {
    computeTopologyChurnKindFigures,
    type TopologyChurnKindFigures
} from './compute-topology-churn-kind-figures.ts';
import { toPlannedTopologyPlans, type PlannedTopologyPlan } from './to-planned-topology-plans.ts';
import type { TopologyChurnLinkSample } from './to-topology-churn-link-sample.ts';

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

interface ComputeTopologyChurnReportInput {
    readonly plans: readonly AdminRoomTopologyPlan[];
    readonly sightings: readonly TopologyChurnPromotionSighting[];
    readonly linkSamples: readonly TopologyChurnLinkSample[];
    readonly phases: readonly TopologyChurnPhaseWindow[];
    readonly replacedLayoutOverlapMs: number;
}

export interface TopologyChurnDistribution {
    readonly min: number;
    readonly median: number;
    readonly p90: number;
    readonly max: number;
}

interface TopologyChurnLongestPathHops {
    readonly first: number;
    readonly last: number;
    readonly max: number;
}

/** Rates and shares are null when their denominator is 0; distributions are null over no values. */
export interface TopologyChurnPhaseReport extends TopologyChurnKindFigures {
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
    /** The reroutes of the reshape plans alone; null when the phase has none. */
    readonly reroutedSessionsPerReshape: TopologyChurnDistribution | null;
    readonly longestPathHops: TopologyChurnLongestPathHops | null;
    /** The plans of the phase whose layout was sampled as an accepted mesh. */
    readonly linkSampledPlanCount: number;
    readonly underLinkedMembersPerPlan: TopologyChurnDistribution | null;
}

export interface TopologyChurnReport {
    readonly phases: readonly TopologyChurnPhaseReport[];
    /** Plans planned in no phase's window: before the first or from the end of the last. */
    readonly outsidePhasesPlanCount: number;
}

interface ComputePhaseFiguresInput {
    readonly plans: readonly PlannedTopologyPlan[];
    readonly durationMs: number;
    readonly sightings: readonly TopologyChurnPromotionSighting[];
    readonly linkSamples: readonly TopologyChurnLinkSample[];
    readonly replacedLayoutOverlapMs: number;
}

const MS_PER_MINUTE = 60_000;

export function computeTopologyChurnReport(input: ComputeTopologyChurnReportInput): TopologyChurnReport {
    const plans = toPlannedTopologyPlans(input.plans);
    return {
        phases: input.phases.map((phase) => {
            const durationMs = phase.endedAtEpochMs - phase.startedAtEpochMs;
            const figures: ComputePhaseFiguresInput = {
                plans: plans.filter((plan) => isWithinPhase(plan, phase)),
                durationMs,
                sightings: input.sightings,
                linkSamples: input.linkSamples,
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
                ...computeCauseFigures(figures.plans),
                ...computeKindFigures(figures),
                ...computeLinkFigures(figures)
            };
        }),
        outsidePhasesPlanCount: plans.filter((plan) => !input.phases.some((phase) => isWithinPhase(plan, phase))).length
    };
}

function isWithinPhase(plan: PlannedTopologyPlan, phase: TopologyChurnPhaseWindow): boolean {
    return plan.plan.plannedAtEpochMs >= phase.startedAtEpochMs &&
        plan.plan.plannedAtEpochMs < phase.endedAtEpochMs;
}

function computePromotionFigures(
    input: ComputePhaseFiguresInput
): Pick<TopologyChurnPhaseReport, 'promotedPlanCount' | 'promotionsPerMinute' | 'promotionLagMs'> {
    const lagsMs = selectPromotedPlans(input).map((promoted) => promoted.lagMs);
    return {
        promotedPlanCount: lagsMs.length,
        promotionsPerMinute: computePerMinute(lagsMs.length, input.durationMs),
        promotionLagMs: computeDistribution(lagsMs)
    };
}

interface PromotedPlan {
    readonly plan: PlannedTopologyPlan;
    readonly lagMs: number;
}

function selectPromotedPlans(input: ComputePhaseFiguresInput): readonly PromotedPlan[] {
    return input.plans.flatMap((plan) => {
        const sighting = input.sightings.find((candidate) => isSameGroupLayoutIdentity(candidate.layout, plan.layout));
        return sighting === undefined
            ? []
            : [{ plan, lagMs: sighting.firstSeenAtEpochMs - plan.plan.plannedAtEpochMs }];
    });
}

function computeKindFigures(
    input: ComputePhaseFiguresInput
): TopologyChurnKindFigures & Pick<TopologyChurnPhaseReport, 'reroutedSessionsPerReshape'> {
    const records = input.plans.map((plan) => plan.plan);
    return {
        ...computeTopologyChurnKindFigures({
            records,
            promotedRecords: selectPromotedPlans(input).map((promoted) => promoted.plan.plan)
        }),
        reroutedSessionsPerReshape: computeDistribution(
            records.filter((record) => record.change?.kind === 'reshape').map((record) =>
                record.delta.reroutedSessionCount
            )
        )
    };
}

function computeLinkFigures(
    input: ComputePhaseFiguresInput
): Pick<TopologyChurnPhaseReport, 'linkSampledPlanCount' | 'underLinkedMembersPerPlan'> {
    const underLinkedMemberCounts = input.plans.flatMap((plan) => {
        const sample = input.linkSamples.find((candidate) => isSameGroupLayoutIdentity(candidate.layout, plan.layout));
        return sample === undefined ? [] : [sample.underLinkedMemberCount];
    });
    return {
        linkSampledPlanCount: underLinkedMemberCounts.length,
        underLinkedMembersPerPlan: computeDistribution(underLinkedMemberCounts)
    };
}

function computeOverlapFigures(
    input: ComputePhaseFiguresInput
): Pick<TopologyChurnPhaseReport, 'insideOverlapPlanCount' | 'insideOverlapShare'> {
    const replacedAgesMs = input.plans.flatMap((plan) => plan.plan.replaced === null ? [] : [plan.plan.replaced.ageMs]);
    const insideOverlapPlanCount = replacedAgesMs.filter((ageMs) => ageMs < input.replacedLayoutOverlapMs).length;
    return {
        insideOverlapPlanCount,
        insideOverlapShare: computeShare(insideOverlapPlanCount, replacedAgesMs.length)
    };
}

function computeEdgeFigures(plans: readonly PlannedTopologyPlan[]): Pick<
    TopologyChurnPhaseReport,
    | 'identityOnlyPlanCount'
    | 'changedSessionsPerPlan'
    | 'reroutedSessionsPerPlan'
    | 'joinersPerPlan'
    | 'maxJoinerEdgesPerSession'
    | 'degreeLimit'
    | 'longestPathHops'
> {
    const edgeChanging = plans.map((plan) => plan.plan).filter((record) => !isEmptyTopologyLayoutDelta(record.delta));
    return {
        identityOnlyPlanCount: plans.length - edgeChanging.length,
        changedSessionsPerPlan: computeDistribution(edgeChanging.map((record) => record.delta.changedSessionCount)),
        reroutedSessionsPerPlan: computeDistribution(edgeChanging.map((record) => record.delta.reroutedSessionCount)),
        joinersPerPlan: computeDistribution(edgeChanging.map((record) => record.delta.joinedSessionCount)),
        maxJoinerEdgesPerSession: Math.max(0, ...plans.map((plan) => plan.plan.delta.maxJoinerEdgesPerSession)),
        degreeLimit: plans.length === 0 ? null : Math.max(...plans.map((plan) => plan.degreeLimit)),
        longestPathHops: computeLongestPathHops(edgeChanging)
    };
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
    plans: readonly PlannedTopologyPlan[]
): Pick<
    TopologyChurnPhaseReport,
    'plansByCause' | 'uncausedPlanCount' | 'reroutingMembershipPlanCount' | 'reroutingMembershipPlanShare'
> {
    const records = plans.map((plan) => plan.plan);
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
    return computeCountsByKey(TOPOLOGY_REPLAN_CAUSES, countPlans);
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
    const extrema = computeNumberExtrema(values);
    if (median === undefined || p90 === undefined || extrema === undefined) {
        return null;
    }
    return { min: extrema.min, median, p90, max: extrema.max };
}
