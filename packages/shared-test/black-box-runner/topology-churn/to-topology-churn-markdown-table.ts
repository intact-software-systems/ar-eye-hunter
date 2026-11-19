import type { AdminRoomReshapeGate } from '@shared/api/admin-rooms/admin-room-topology-plans.ts';
import type { EffectiveGroupTopologyConfig } from '@shared/api/graph-topology-management-types.ts';
import type { GroupTopologyReplanningMode } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { RallarRtcTopologyKind } from '@shared/api/overlay-topology.ts';
import { TOPOLOGY_RESHAPE_REASONS } from '@shared/api/topology-plan/topology-plan-change.ts';
import { HELD_TOPOLOGY_RESHAPE_REASONS } from '@shared/api/topology-plan/topology-reshape-gate.ts';

import type { TopologyChurnDrift } from './compute-topology-churn-drift.ts';
import type {
    TopologyChurnDistribution,
    TopologyChurnPhaseReport,
    TopologyChurnReport
} from './compute-topology-churn-report.ts';

export interface TopologyChurnRoomEntry {
    readonly replanning: GroupTopologyReplanningMode;
    readonly memberCount: number;
    readonly topology: readonly RallarRtcTopologyKind[];
    readonly report: TopologyChurnReport;
    readonly drift: TopologyChurnDrift;
    readonly topologyConfig: EffectiveGroupTopologyConfig;
    /** The gate as read once the room converged; null when the room stores none. */
    readonly reshapeGate: AdminRoomReshapeGate | null;
}

const NO_FIGURE = '—';

const COLUMNS: readonly (readonly [string, (phase: TopologyChurnPhaseReport) => string])[] = [
    ['phase', (phase) => phase.phase],
    ['duration s', (phase) => (phase.durationMs / 1_000).toFixed(1)],
    ['joins', (phase) => String(phase.joinCount)],
    ['leaves', (phase) => String(phase.leaveCount)],
    ['appointments', (phase) => String(phase.appointmentCount)],
    ['rtt reports', (phase) => String(phase.rttReportCount)],
    ['plans', (phase) => String(phase.planCount)],
    ['plans/min', (phase) => toFixedFigure(phase.plansPerMinute, 1)],
    ['promoted', (phase) => String(phase.promotedPlanCount)],
    ['promotions/min', (phase) => toFixedFigure(phase.promotionsPerMinute, 1)],
    ['promotion lag ms min/p50/p90/max', (phase) => toDistributionFigure(phase.promotionLagMs)],
    ['inside overlap', (phase) => String(phase.insideOverlapPlanCount)],
    ['inside overlap share', (phase) => toFixedFigure(phase.insideOverlapShare, 2)],
    ['identity-only', (phase) => String(phase.identityOnlyPlanCount)],
    ['changed sessions min/p50/p90/max', (phase) => toDistributionFigure(phase.changedSessionsPerPlan)],
    ['rerouted sessions min/p50/p90/max', (phase) => toDistributionFigure(phase.reroutedSessionsPerPlan)],
    ['joiners min/p50/p90/max', (phase) => toDistributionFigure(phase.joinersPerPlan)],
    ['rerouting membership plans', (phase) => String(phase.reroutingMembershipPlanCount)],
    ['rerouting membership share', (phase) => toFixedFigure(phase.reroutingMembershipPlanShare, 2)],
    ['max joiner edges', (phase) => String(phase.maxJoinerEdgesPerSession)],
    ['degree limit', (phase) => phase.degreeLimit === null ? NO_FIGURE : String(phase.degreeLimit)],
    ['kinds attach/repair/reshape', (phase) => toKindFigure(phase.plansByKind)],
    ['promoted kinds attach/repair/reshape', (phase) => toKindFigure(phase.promotedPlansByKind)],
    ['rerouting kinds attach/repair/reshape', (phase) => toKindFigure(phase.reroutingPlansByKind)],
    ['reshape reasons', (phase) => toReshapeReasonFigure(phase.reshapesByReason)],
    ['held', (phase) => toHeldFigure(phase)],
    ['reshapes/min', (phase) => toFixedFigure(phase.reshapesPerMinute, 1)],
    ['closest reshapes (s)', (phase) => toSecondsFigure(phase.closestReshapesMs)],
    ['rerouted per reshape min/p50/p90/max', (phase) => toDistributionFigure(phase.reroutedSessionsPerReshape)],
    [
        'rerouted per reshape by reason p50/max',
        (phase) => toReroutesByReasonFigure(phase.reroutedSessionsPerReshapeByReason)
    ],
    ['causes join/leave/leader-change/config/rtt', (phase) => toCauseFigure(phase.plansByCause)],
    ['uncaused', (phase) => String(phase.uncausedPlanCount)],
    ['longest path hops first/last/max', (phase) => toLongestPathFigure(phase.longestPathHops)],
    ['link-sampled plans', (phase) => String(phase.linkSampledPlanCount)],
    ['members under k links min/p50/p90/max', (phase) => toDistributionFigure(phase.underLinkedMembersPerPlan)]
];

export function toTopologyChurnMarkdownTable(entry: TopologyChurnRoomEntry): string {
    const kinds = entry.topology.length === 0 ? NO_FIGURE : entry.topology.join(' → ');
    return [
        `### ${entry.replanning}, ${entry.memberCount} members, ${kinds}`,
        '',
        toMarkdownRow(COLUMNS.map(([title]) => title)),
        toMarkdownRow(COLUMNS.map(() => '---')),
        ...entry.report.phases.map((phase) => toMarkdownRow(COLUMNS.map(([, toCell]) => toCell(phase)))),
        '',
        `Plans outside every phase: ${entry.report.outsidePhasesPlanCount}. Drift: ${toDriftFigure(entry.drift)}`,
        toClosestReshapesLine(entry.report.closestReshapesMs),
        toConfigurationLine(entry.topologyConfig)
    ].join('\n');
}

function toMarkdownRow(cells: readonly string[]): string {
    return `| ${cells.join(' | ')} |`;
}

function toFixedFigure(value: number | null, fractionDigits: number): string {
    return value === null ? NO_FIGURE : value.toFixed(fractionDigits);
}

function toSecondsFigure(durationMs: number | null): string {
    return durationMs === null ? NO_FIGURE : (durationMs / 1_000).toFixed(1);
}

function toHeldFigure(phase: TopologyChurnPhaseReport): string {
    const reasons = HELD_TOPOLOGY_RESHAPE_REASONS.flatMap((reason) => {
        const count = phase.heldReshapesByReason[reason];
        return count === 0 ? [] : [`${reason}: ${count}`];
    });
    return reasons.length === 0
        ? String(phase.heldReshapePlanCount)
        : `${phase.heldReshapePlanCount} (${reasons.join(', ')})`;
}

function toClosestReshapesLine(closestReshapesMs: number | null): string {
    return closestReshapesMs === null
        ? `Closest two reshapes of the room: ${NO_FIGURE} (fewer than two reshapes).`
        : `Closest two reshapes of the room: ${toSecondsFigure(closestReshapesMs)} s apart.`;
}

function toDistributionFigure(distribution: TopologyChurnDistribution | null): string {
    return distribution === null
        ? NO_FIGURE
        : [distribution.min, distribution.median, distribution.p90, distribution.max].join(' / ');
}

function toCauseFigure(plansByCause: TopologyChurnPhaseReport['plansByCause']): string {
    return [plansByCause.join, plansByCause.leave, plansByCause['leader-change'], plansByCause.config, plansByCause.rtt]
        .join(' / ');
}

function toKindFigure(counts: TopologyChurnPhaseReport['plansByKind']): string {
    return [counts.attach, counts.repair, counts.reshape].join(' / ');
}

function toReshapeReasonFigure(reshapesByReason: TopologyChurnPhaseReport['reshapesByReason']): string {
    const reasons = Object.entries(reshapesByReason).filter(([, count]) => count > 0);
    return reasons.length === 0 ? NO_FIGURE : reasons.map(([reason, count]) => `${reason}: ${count}`).join(', ');
}

function toReroutesByReasonFigure(
    reroutesByReason: TopologyChurnPhaseReport['reroutedSessionsPerReshapeByReason']
): string {
    const reasons = TOPOLOGY_RESHAPE_REASONS.flatMap((reason) => {
        const distribution = reroutesByReason[reason];
        return distribution === null ? [] : [`${reason}: ${distribution.median}/${distribution.max}`];
    });
    return reasons.length === 0 ? NO_FIGURE : reasons.join(', ');
}

function toLongestPathFigure(hops: TopologyChurnPhaseReport['longestPathHops']): string {
    return hops === null ? NO_FIGURE : [hops.first, hops.last, hops.max].join(' / ');
}

function toDriftFigure(drift: TopologyChurnDrift): string {
    const shorterNote = drift.hopDifference < 0 ? ' (negative: the accepted layout is shorter)' : '';
    return `accepted ${drift.acceptedLongestPathHops} hops, fresh no-RTT plan ${drift.freshLongestPathHops} hops, ` +
        `difference ${drift.hopDifference}${shorterNote}.`;
}

function toConfigurationLine(config: EffectiveGroupTopologyConfig): string {
    return `Room configuration: kind ${config.topologyKind}, tree from ${config.treeMinSize} members, ` +
        `mesh from ${config.meshMinSize}, k = ${config.meshParamK}, degree limit ${config.degreeLimit}.`;
}
