import type {
    ControlEventEnvelope,
    ControlResultEnvelope,
} from '../../rallar-black-box/src/control-protocol.ts';
import type {
    ControlQueuedCommandSnapshot,
    ControlRunSnapshot,
} from './control-service.ts';
import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';

export const CONTROL_ARTIFACT_SCHEMA_VERSION = 1;

export type ControlRunArtifactFileName =
    | 'report.json'
    | 'events.jsonl'
    | 'failures.json'
    | 'metadata.json';

export type ControlRunArtifactBundle = Readonly<{
    artifactSchemaVersion: typeof CONTROL_ARTIFACT_SCHEMA_VERSION;
    runId: string;
    generatedAtEpochMs: number;
    files: Readonly<Record<ControlRunArtifactFileName, string>>;
}>;

export type ControlRunFailureBundle = Readonly<{
    summary: ControlRunArtifactSummary;
    failures: readonly Record<string, unknown>[];
    outputs: Record<string, unknown>;
}>;

type ControlRunArtifactSummary = Readonly<{
    total: number;
    success: number;
    failure: number;
    commandCount: number;
    eventCount: number;
    agentCount: number;
    reportCount: number;
}>;

const CONTROL_ARTIFACT_FILE_NAMES: readonly ControlRunArtifactFileName[] = [
    'report.json',
    'events.jsonl',
    'failures.json',
    'metadata.json',
];

function commandById(run: ControlRunSnapshot): Map<string, ControlQueuedCommandSnapshot> {
    return new Map(run.commands.map(command => [
        command.envelope.commandId,
        command,
    ]));
}

function commandAction(command: ControlQueuedCommandSnapshot | undefined): string {
    return command?.envelope.command.kind ?? 'unknown';
}

function commandConnection(command: ControlQueuedCommandSnapshot | undefined): unknown {
    return command?.envelope.command && 'connection' in command.envelope.command
        ? command.envelope.command.connection
        : undefined;
}

function commandTransport(command: ControlQueuedCommandSnapshot | undefined): string {
    const transport = command?.envelope.command && 'transport' in command.envelope.command
        ? command.envelope.command.transport
        : undefined;
    return typeof transport === 'string' && transport.length > 0 ? transport : 'control';
}

function redact<T>(value: T): T {
    return redactRallarBlackBoxValue(value);
}

function artifactSummary(run: ControlRunSnapshot): ControlRunArtifactSummary {
    const success = run.results.filter(result => result.ok).length;
    const failure = run.results.length - success;
    return {
        total: run.results.length,
        success,
        failure,
        commandCount: run.commands.length,
        eventCount: run.events.length,
        agentCount: run.agents.length,
        reportCount: run.reports.length,
    };
}

function resultStatus(result: ControlResultEnvelope): 'SUCCESS' | 'FAILURE' {
    return result.ok ? 'SUCCESS' : 'FAILURE';
}

function resultActual(result: ControlResultEnvelope): unknown {
    return result.ok ? result.result?.value ?? result.result : result.error;
}

function resultRows(run: ControlRunSnapshot): readonly Record<string, unknown>[] {
    const commands = commandById(run);
    return run.results.map(result => {
        const command = commands.get(result.commandId);
        return redact({
            resultKey: `${result.agentId}:${result.commandId}`,
            name: result.commandId,
            status: resultStatus(result),
            transport: commandTransport(command),
            action: commandAction(command),
            connection: commandConnection(command) ?? result.agentId,
            agentId: result.agentId,
            commandId: result.commandId,
            replayed: result.replayed,
            actual: resultActual(result),
        });
    });
}

function artifactEventFromResult(row: Record<string, unknown>): Record<string, unknown> {
    return redact({
        kind: 'step-result',
        name: row.name,
        status: row.status,
        transport: row.transport,
        action: row.action,
        connection: row.connection,
        agentId: row.agentId,
        commandId: row.commandId,
        actual: row.actual,
    });
}

function artifactEventFromControlEvent(event: ControlEventEnvelope): Record<string, unknown> {
    return redact({
        kind: 'rtc-diagnostic',
        name: event.eventId ?? event.commandId ?? event.kind,
        status: event.kind,
        agentId: event.agentId,
        connection: event.commandId ?? event.agentId,
        commandId: event.commandId,
        atEpochMs: event.atEpochMs,
        value: event.payload,
    });
}

function jsonl(values: readonly unknown[]): string {
    return values.map(value => JSON.stringify(value)).join('\n') + (values.length > 0 ? '\n' : '');
}

export function controlRunEventsJsonl(run: ControlRunSnapshot): string {
    const rows = resultRows(run);
    return jsonl([
        ...rows.map(artifactEventFromResult),
        ...run.events.map(artifactEventFromControlEvent),
    ]);
}

export function controlRunResultsJsonl(run: ControlRunSnapshot): string {
    return jsonl(resultRows(run));
}

export function controlRunFailureBundle(run: ControlRunSnapshot): ControlRunFailureBundle {
    const rows = resultRows(run);
    const failures = rows.filter(row => row.status === 'FAILURE');
    return {
        summary: artifactSummary(run),
        failures,
        outputs: redact({
            runId: run.runId,
            generatedFrom: 'rallar-black-box-control-server',
            agentIds: run.agents.map(agent => agent.agentId),
            reportCount: run.reports.length,
        }),
    };
}

export function createControlRunArtifactBundle(
    run: ControlRunSnapshot,
    generatedAtEpochMs = Date.now(),
): ControlRunArtifactBundle {
    const rows = resultRows(run);
    const summary = artifactSummary(run);
    const outputs = redact({
        runId: run.runId,
        agents: run.agents.map(agent => ({
            agentId: agent.agentId,
            connected: agent.connected,
            status: agent.status,
            completedCommands: agent.completedCommandIds.length,
            receivedEvents: agent.receivedEventCount,
            receivedResults: agent.receivedResultCount,
        })),
        commandCount: run.commands.length,
        eventCount: run.events.length,
        reportCount: run.reports.length,
    });
    const report = {
        schemaVersion: CONTROL_ARTIFACT_SCHEMA_VERSION,
        artifactSchemaVersion: CONTROL_ARTIFACT_SCHEMA_VERSION,
        summary,
        results: Object.fromEntries(rows.map(row => [String(row.resultKey), row])),
        resultsList: rows,
        outputs,
        metrics: {
            heartbeats: run.heartbeats.length,
            stats: run.stats.length,
        },
    };
    const metadata = {
        schemaVersion: CONTROL_ARTIFACT_SCHEMA_VERSION,
        artifactSchemaVersion: CONTROL_ARTIFACT_SCHEMA_VERSION,
        generatedAtEpochMs,
        config: 'rallar-black-box-control-server',
        execution: 'run',
        summary,
        command: [
            'rallar-black-box-control-server',
            'export-run-artifact',
            run.runId,
        ],
    };

    return {
        artifactSchemaVersion: CONTROL_ARTIFACT_SCHEMA_VERSION,
        runId: run.runId,
        generatedAtEpochMs,
        files: {
            'report.json': JSON.stringify(report, null, 2),
            'events.jsonl': controlRunEventsJsonl(run),
            'failures.json': JSON.stringify(controlRunFailureBundle(run), null, 2),
            'metadata.json': JSON.stringify(metadata, null, 2),
        },
    };
}

export function controlRunArtifactFileNameFromValue(
    value: string,
): ControlRunArtifactFileName | undefined {
    return CONTROL_ARTIFACT_FILE_NAMES.includes(value as ControlRunArtifactFileName)
        ? value as ControlRunArtifactFileName
        : undefined;
}

export function controlRunArtifactContentType(fileName: ControlRunArtifactFileName): string {
    return fileName.endsWith('.jsonl')
        ? 'application/x-ndjson; charset=utf-8'
        : 'application/json';
}
