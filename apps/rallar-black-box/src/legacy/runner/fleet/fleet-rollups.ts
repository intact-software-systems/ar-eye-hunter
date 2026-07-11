import type {
    ControlFleetFailureSignature,
    ControlFleetReportsResponse,
    ControlFleetRunReport,
} from '../../../control-run-manager.ts';
import { fleetRegionKey } from './fleet-presentation.ts';
import { fleetTimingDistribution } from './fleet-timing.ts';

export function fleetDisplaySummary(
    reports: readonly ControlFleetRunReport[],
    response: ControlFleetReportsResponse | undefined,
): Readonly<{
    runs: number;
    agents: number;
    regions: number;
    passRate: number;
    failureGroups: number;
    p95DurationMs?: number;
    stale: number;
}> {
    if (reports.length === 0) {
        return {
            runs: response?.aggregate.runCount ?? 0,
            agents: response?.aggregate.agentCount ?? 0,
            regions: response?.aggregate.regionCount ?? 0,
            passRate: response?.aggregate.passRate ?? 0,
            failureGroups: response?.aggregate.failureGroupCount ?? 0,
            p95DurationMs: response?.aggregate.timing.runs.p95Ms,
            stale: response?.aggregate.staleAgentCount ?? 0,
        };
    }
    const agents = new Set<string>();
    const regions = new Set<string>();
    const staleAgents = new Set<string>();
    let passed = 0;
    let outcomes = 0;
    reports.forEach((report) => {
        report.agents.forEach((agent) => {
            agents.add(agent.agentId);
            regions.add(fleetRegionKey(agent.label));
            if (agent.stale) {
                staleAgents.add(agent.agentId);
            }
            outcomes += 1;
            if (agent.ok) {
                passed += 1;
            }
        });
    });
    return {
        runs: reports.length,
        agents: agents.size,
        regions: regions.size,
        passRate: outcomes > 0 ? passed / outcomes : 0,
        failureGroups: fleetFailureRows(reports).length,
        p95DurationMs: fleetTimingDistribution(
            reports
                .map((report) => report.runDurationMs)
                .filter((value): value is number => value !== undefined),
        ).p95Ms,
        stale: staleAgents.size,
    };
}

export function fleetFailureRows(
    reports: readonly ControlFleetRunReport[],
): readonly ControlFleetFailureSignature[] {
    type MutableFailure = {
        -readonly [K in keyof Omit<
            ControlFleetFailureSignature,
            'affectedAgents' | 'affectedRegions' | 'affectedRuns'
        >]: ControlFleetFailureSignature[K];
    } & {
        affectedAgents: Set<string>;
        affectedRegions: Set<string>;
        affectedRuns: Set<string>;
    };
    const signatures = new Map<string, MutableFailure>();
    reports.forEach((report) => {
        report.failureSignatures.forEach((signature) => {
            const current = signatures.get(signature.signatureId) ?? {
                ...signature,
                count: 0,
                firstSeenAtEpochMs: signature.firstSeenAtEpochMs,
                lastSeenAtEpochMs: signature.lastSeenAtEpochMs,
                affectedAgents: new Set<string>(),
                affectedRegions: new Set<string>(),
                affectedRuns: new Set<string>(),
            };
            current.count += signature.count;
            current.firstSeenAtEpochMs = minDefined(
                current.firstSeenAtEpochMs,
                signature.firstSeenAtEpochMs,
            );
            current.lastSeenAtEpochMs = maxDefined(
                current.lastSeenAtEpochMs,
                signature.lastSeenAtEpochMs,
            );
            signature.affectedAgents.forEach((agentId) =>
                current.affectedAgents.add(agentId)
            );
            signature.affectedRegions.forEach((region) =>
                current.affectedRegions.add(region)
            );
            signature.affectedRuns.forEach((runId) =>
                current.affectedRuns.add(runId)
            );
            current.affectedRuns.add(report.distributedRunId);
            signatures.set(signature.signatureId, current);
        });
    });
    return [...signatures.values()]
        .map((signature) => ({
            ...signature,
            affectedAgents: [...signature.affectedAgents].sort(),
            affectedRegions: [...signature.affectedRegions].sort(),
            affectedRuns: [...signature.affectedRuns].sort(),
        }))
        .sort((left, right) =>
            right.count - left.count ||
            (right.lastSeenAtEpochMs ?? 0) - (left.lastSeenAtEpochMs ?? 0)
        );
}

function minDefined(
    left: number | undefined,
    right: number | undefined,
): number | undefined {
    if (left === undefined) {
        return right;
    }
    if (right === undefined) {
        return left;
    }
    return Math.min(left, right);
}

function maxDefined(
    left: number | undefined,
    right: number | undefined,
): number | undefined {
    if (left === undefined) {
        return right;
    }
    if (right === undefined) {
        return left;
    }
    return Math.max(left, right);
}
