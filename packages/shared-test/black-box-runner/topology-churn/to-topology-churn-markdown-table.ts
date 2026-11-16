import type { GroupTopologyReplanningMode } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { RallarRtcTopologyKind } from '@shared/api/overlay-topology.ts';

import type {
    TopologyChurnDistribution,
    TopologyChurnPhaseReport,
    TopologyChurnReport
} from './compute-topology-churn-report.ts';

export interface TopologyChurnRoomEntry {
    readonly replanning: GroupTopologyReplanningMode;
    readonly memberCount: number;
    /** Each kind the room's plans used, once, in planned order. */
    readonly topology: readonly RallarRtcTopologyKind[];
    readonly report: TopologyChurnReport;
    /** No typed read serves the room's mesh parameter, so the no-RTT comparison cannot be computed. */
    readonly drift: null;
}

const NO_FIGURE = '—';

const COLUMNS: readonly (readonly [string, (phase: TopologyChurnPhaseReport) => string])[] = [
    ['phase', (phase) => phase.phase],
    ['duration s', (phase) => (phase.durationMs / 1_000).toFixed(1)],
    ['joins', (phase) => String(phase.joinCount)],
    ['leaves', (phase) => String(phase.leaveCount)],
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
    ['causes join/leave/leader-change/config/rtt', (phase) => toCauseFigure(phase.plansByCause)],
    ['uncaused', (phase) => String(phase.uncausedPlanCount)],
    ['longest path hops first/last/max', (phase) => toLongestPathFigure(phase.longestPathHops)]
];

export function toTopologyChurnMarkdownTable(entry: TopologyChurnRoomEntry): string {
    const kinds = entry.topology.length === 0 ? NO_FIGURE : entry.topology.join(' → ');
    return [
        `### ${entry.replanning}, ${entry.memberCount} members, ${kinds}`,
        '',
        toMarkdownRow(COLUMNS.map(([title]) => title)),
        toMarkdownRow(COLUMNS.map(() => '---')),
        ...entry.report.phases.map((phase) => toMarkdownRow(COLUMNS.map(([, toCell]) => toCell(phase))))
    ].join('\n');
}

function toMarkdownRow(cells: readonly string[]): string {
    return `| ${cells.join(' | ')} |`;
}

function toFixedFigure(value: number | null, fractionDigits: number): string {
    return value === null ? NO_FIGURE : value.toFixed(fractionDigits);
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

function toLongestPathFigure(hops: TopologyChurnPhaseReport['longestPathHops']): string {
    return hops === null ? NO_FIGURE : [hops.first, hops.last, hops.max].join(' / ');
}
