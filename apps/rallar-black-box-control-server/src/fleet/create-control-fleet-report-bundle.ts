import {
    RALLAR_BLACK_BOX_FLEET_REPORT_SCHEMA_VERSION,
    type ControlFleetReportBundle,
    type ControlFleetRunReport
} from '@shared-test/rallar-bb-test/fleet-report.ts';

const AGENT_RESULT_COLUMNS = [
    'agentId',
    'region',
    'provider',
    'state',
    'durationMs',
    'failedCommandCount',
    'reconnectCount',
    'stale'
];
const FAILURE_SIGNATURE_COLUMNS = [
    'signatureId',
    'category',
    'code',
    'recipeId',
    'transport',
    'count',
    'affectedAgents',
    'affectedRegions',
    'nextAction'
];
const SUMMARY_FAILURE_LIMIT = 8;

export function createControlFleetReportBundle(
    report: ControlFleetRunReport,
    generatedAtEpochMs: number
): ControlFleetReportBundle {
    return {
        fleetReportSchemaVersion: RALLAR_BLACK_BOX_FLEET_REPORT_SCHEMA_VERSION,
        distributedRunId: report.distributedRunId,
        generatedAtEpochMs,
        files: {
            'fleet-report.json': JSON.stringify(report, null, 2),
            'summary.md': toFleetSummaryMarkdown(report),
            'agent-results.csv': toCsv([AGENT_RESULT_COLUMNS, ...toAgentResultRows(report)]),
            'failure-signatures.csv': toCsv([FAILURE_SIGNATURE_COLUMNS, ...toFailureSignatureRows(report)])
        }
    };
}

function toAgentResultRows(report: ControlFleetRunReport): readonly (readonly string[])[] {
    return report.agents.map((agent) => [
        agent.agentId,
        agent.label.region ?? '',
        agent.label.provider ?? '',
        agent.state,
        agent.durationMs === undefined ? '' : String(agent.durationMs),
        String(agent.failedCommandCount),
        String(agent.reconnectCount),
        String(agent.stale)
    ]);
}

function toFailureSignatureRows(report: ControlFleetRunReport): readonly (readonly string[])[] {
    return report.failureSignatures.map((signature) => [
        signature.signatureId,
        signature.category,
        signature.code ?? '',
        signature.recipeId ?? '',
        signature.transport ?? '',
        String(signature.count),
        signature.affectedAgents.join('|'),
        signature.affectedRegions.join('|'),
        signature.nextAction
    ]);
}

function toFleetSummaryMarkdown(report: ControlFleetRunReport): string {
    return [
        `# Fleet Run Report: ${report.distributedRunId}`,
        '',
        `State: ${report.state}`,
        `Pass rate: ${Math.round(report.summary.passRate * 100)}%`,
        `Agents: ${report.summary.agents}`,
        `Regions: ${report.summary.regions}`,
        `Failure groups: ${report.summary.failureGroups}`,
        '',
        '## Dominant Failures',
        ...report.failureSignatures.slice(0, SUMMARY_FAILURE_LIMIT).map((signature) =>
            `- ${signature.title}: ${signature.count} occurrence(s), ${
                signature.affectedRegions.join(', ') || 'no region'
            } - ${signature.nextAction}`
        )
    ].join('\n');
}

function toCsv(rows: readonly (readonly string[])[]): string {
    return rows.map((row) => row.map(toCsvCell).join(',')).join('\n');
}

function toCsvCell(value: string): string {
    return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
