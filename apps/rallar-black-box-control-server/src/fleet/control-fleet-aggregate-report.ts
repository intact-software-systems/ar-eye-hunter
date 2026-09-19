import type { ControlFleetAggregateReport, ControlFleetRunReport } from '@shared-test/rallar-bb-test/fleet-report.ts';

import { computeAggregateFleetFailureSignatures } from './control-fleet-failure-signatures.ts';
import {
    toFleetRegionSummaries,
    toFleetTimingDistribution,
    toRatio,
    toSortedUniqueValues
} from './control-fleet-statistics.ts';

export interface FleetReportFilter {
    readonly region?: string;
    readonly provider?: string;
    readonly recipeId?: string;
    readonly groupId?: string;
    readonly state?: string;
    readonly fromEpochMs?: number;
    readonly toEpochMs?: number;
}

export function createControlFleetAggregateReport(
    reports: readonly ControlFleetRunReport[],
    generatedAtEpochMs: number
): ControlFleetAggregateReport {
    const agents = reports.flatMap((report) => report.agents);
    const regions = toFleetRegionSummaries(agents.map((agent) => ({ ...agent, flaky: false })));
    const failures = computeAggregateFleetFailureSignatures(reports);
    const passed = reports.reduce((count, report) => count + report.summary.passed, 0);
    const totalAgents = reports.reduce((count, report) => count + report.summary.agents, 0);
    return {
        generatedAtEpochMs,
        reportCount: reports.length,
        runCount: toSortedUniqueValues(reports.map((report) => report.distributedRunId)).length,
        agentCount: toSortedUniqueValues(agents.map((agent) => agent.agentId)).length,
        regionCount: regions.length,
        passRate: toRatio(passed, totalAgents),
        staleAgentCount:
            toSortedUniqueValues(agents.filter((agent) => agent.stale).map((agent) => agent.agentId)).length,
        flakyAgentCount: toFlakyAgentIds(reports).length,
        failureGroupCount: failures.length,
        timing: {
            runs: toFleetTimingDistribution(
                reports.flatMap((report) => report.runDurationMs === undefined ? [] : [report.runDurationMs])
            ),
            commands: toFleetTimingDistribution(reports.flatMap((report) => toCommandTimingSamples(report)))
        },
        regions,
        failureSignatures: failures
    };
}

export function filterControlFleetReports(
    reports: readonly ControlFleetRunReport[],
    filter: FleetReportFilter
): readonly ControlFleetRunReport[] {
    return reports
        .filter((report) => isFleetReportSelected(report, filter))
        .sort((left, right) => right.generatedAtEpochMs - left.generatedAtEpochMs);
}

function isFleetReportSelected(report: ControlFleetRunReport, filter: FleetReportFilter): boolean {
    return (!filter.region || report.regions.some((region) => region.region === filter.region)) &&
        (!filter.provider || report.regions.some((region) => region.provider === filter.provider)) &&
        (!filter.recipeId || report.recipeIds.includes(filter.recipeId)) &&
        (!filter.groupId || report.group.groupId === filter.groupId) &&
        (!filter.state || report.state === filter.state) &&
        (filter.fromEpochMs === undefined || report.generatedAtEpochMs >= filter.fromEpochMs) &&
        (filter.toEpochMs === undefined || report.generatedAtEpochMs <= filter.toEpochMs);
}

function toCommandTimingSamples(report: ControlFleetRunReport): readonly number[] {
    const commands = report.timing.commands;
    return [commands.minMs, commands.p50Ms, commands.p90Ms, commands.p95Ms, commands.maxMs]
        .filter((value): value is number => value !== undefined);
}

function toFlakyAgentIds(reports: readonly ControlFleetRunReport[]): readonly string[] {
    const outcomesByAgentId = new Map<string, Set<string>>();
    for (const agent of reports.flatMap((report) => report.agents)) {
        const outcomes = outcomesByAgentId.get(agent.agentId) ?? new Set<string>();
        outcomes.add(agent.ok ? 'passed' : 'not-passed');
        outcomesByAgentId.set(agent.agentId, outcomes);
    }
    return [...outcomesByAgentId.entries()]
        .filter(([, outcomes]) => outcomes.size > 1)
        .map(([agentId]) => agentId)
        .sort();
}
