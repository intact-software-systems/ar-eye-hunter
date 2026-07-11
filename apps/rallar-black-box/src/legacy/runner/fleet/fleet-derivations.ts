import type {
    ControlFleetAgentRunOutcome,
    ControlFleetRunReport,
} from '../../../control-run-manager.ts';
import type { FleetAgentHeatmapRow } from './fleet-types.ts';
import { fleetRegionKey } from './fleet-presentation.ts';
import { fleetTimingDistribution } from './fleet-timing.ts';

export function fleetHeatmapRows(
    reports: readonly ControlFleetRunReport[],
    runs: readonly ControlFleetRunReport[],
): readonly FleetAgentHeatmapRow[] {
    const latestByAgent = new Map<string, ControlFleetAgentRunOutcome>();
    reports.forEach((report) => {
        report.agents.forEach((agent) => {
            if (!latestByAgent.has(agent.agentId)) {
                latestByAgent.set(agent.agentId, agent);
            }
        });
    });
    return [...latestByAgent.values()]
        .map((agent) => ({
            agent,
            region: agent.label.region ?? 'unlabeled',
            provider: agent.label.provider ?? 'unknown',
            cells: runs.map((run) =>
                run.agents.find((candidate) =>
                    candidate.agentId === agent.agentId
                )
            ),
        }))
        .sort((left, right) =>
            `${left.region}/${left.provider}/${left.agent.agentId}`
                .localeCompare(
                    `${right.region}/${right.provider}/${right.agent.agentId}`,
                )
        );
}

export function fleetRegionRows(reports: readonly ControlFleetRunReport[]) {
    type MutableRegion = {
        region: string;
        provider?: string;
        agentIds: Set<string>;
        passed: number;
        failed: number;
        missing: number;
        flaky: number;
        stale: number;
        durations: number[];
        failureCounts: Map<string, number>;
    };
    const regions = new Map<string, MutableRegion>();
    reports.forEach((report) => {
        report.agents.forEach((agent) => {
            const key = fleetRegionKey(agent.label);
            const row = regions.get(key) ?? {
                region: agent.label.region ?? 'unlabeled',
                provider: agent.label.provider,
                agentIds: new Set<string>(),
                passed: 0,
                failed: 0,
                missing: 0,
                flaky: 0,
                stale: 0,
                durations: [],
                failureCounts: new Map<string, number>(),
            };
            row.agentIds.add(agent.agentId);
            if (agent.state === 'passed') {
                row.passed += 1;
            } else if (agent.state === 'failed') {
                row.failed += 1;
            } else if (agent.missing) {
                row.missing += 1;
            }
            if (agent.flaky) {
                row.flaky += 1;
            }
            if (agent.stale) {
                row.stale += 1;
            }
            if (agent.durationMs !== undefined) {
                row.durations.push(agent.durationMs);
            }
            agent.failureSignatureIds.forEach((signatureId) => {
                row.failureCounts.set(
                    signatureId,
                    (row.failureCounts.get(signatureId) ?? 0) + 1,
                );
            });
            regions.set(key, row);
        });
    });
    return [...regions.values()]
        .map((row) => {
            const total = row.passed + row.failed + row.missing;
            return {
                region: row.region,
                provider: row.provider,
                agentCount: row.agentIds.size,
                passed: row.passed,
                failed: row.failed,
                missing: row.missing,
                flaky: row.flaky,
                stale: row.stale,
                passRate: total > 0 ? row.passed / total : 0,
                timing: fleetTimingDistribution(row.durations),
                dominantFailureSignatureId: [...row.failureCounts.entries()]
                    .sort((left, right) => right[1] - left[1])[0]?.[0],
            };
        })
        .sort((left, right) =>
            right.failed - left.failed ||
            left.region.localeCompare(right.region)
        );
}

export function fleetMissingLabelAgents(
    reports: readonly ControlFleetRunReport[],
): readonly string[] {
    const missing = new Set<string>();
    reports.forEach((report) => {
        report.agents.forEach((agent) => {
            if (!agent.label.region || !agent.label.provider) {
                missing.add(agent.agentId);
            }
        });
    });
    return [...missing].sort();
}

export function fleetAgentDetail(
    agentId: string,
    reports: readonly ControlFleetRunReport[],
) {
    const entries = reports
        .map((run) => ({
            run,
            outcome: run.agents.find((agent) => agent.agentId === agentId),
        }))
        .filter((entry) => entry.outcome !== undefined);
    const agent = entries[0]?.outcome;
    if (!agent) {
        return undefined;
    }
    return {
        agent,
        runs: entries.slice(0, 12),
        passed: entries.filter((entry) => entry.outcome?.state === 'passed')
            .length,
        failed: entries.filter((entry) => entry.outcome?.state === 'failed')
            .length,
        missing: entries.filter((entry) => entry.outcome?.missing).length,
        reconnectCount: Math.max(
            0,
            ...entries.map((entry) => entry.outcome?.reconnectCount ?? 0),
        ),
        diagnosticCount: entries.reduce(
            (sum, entry) => sum + (entry.outcome?.diagnosticCount ?? 0),
            0,
        ),
    };
}
