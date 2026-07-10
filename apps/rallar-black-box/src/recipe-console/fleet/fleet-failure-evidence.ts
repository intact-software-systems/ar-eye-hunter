import type {
    ControlFleetFailureSignature,
    ControlFleetRunReport,
} from '@shared-test/rallar-bb-test/fleet-report.ts';

export type FleetFailureRunEvidence = Readonly<{
    report: ControlFleetRunReport;
    agentId?: string;
}>;

export function resolveFleetFailureRunEvidence(input: Readonly<{
    failure: ControlFleetFailureSignature;
    preferredRunId?: string;
    reports: readonly ControlFleetRunReport[];
}>): FleetFailureRunEvidence | undefined {
    const reportsByRunId = new Map(input.reports.map(report => [
        report.distributedRunId,
        report,
    ]));
    const affectedRunIds = new Set(input.failure.affectedRuns);
    const candidates = input.preferredRunId === undefined
        ? input.failure.affectedRuns
        : [input.preferredRunId, ...input.failure.affectedRuns];
    const seen = new Set<string>();
    for (const runId of candidates) {
        if (seen.has(runId) || !affectedRunIds.has(runId)) continue;
        seen.add(runId);
        const report = reportsByRunId.get(runId);
        if (!report || !reportProvesFailure(report, input.failure.signatureId)) {
            continue;
        }
        const affectedAgents = new Set(input.failure.affectedAgents);
        const agentId = report.agents
            .filter(agent => affectedAgents.has(agent.agentId) &&
                agent.failureSignatureIds.includes(input.failure.signatureId))
            .map(agent => agent.agentId)
            .sort(compareIdentifier)[0];
        return agentId === undefined ? { report } : { report, agentId };
    }
    return undefined;
}

function reportProvesFailure(
    report: ControlFleetRunReport,
    signatureId: string,
): boolean {
    return report.failureSignatures.some(
        failure => failure.signatureId === signatureId,
    ) || report.agents.some(
        agent => agent.failureSignatureIds.includes(signatureId),
    );
}

function compareIdentifier(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
