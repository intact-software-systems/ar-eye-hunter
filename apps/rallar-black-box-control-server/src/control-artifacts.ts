import type { ControlEventEnvelope, ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type {
    ControlDistributedRunArtifactBaseFileName,
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunArtifactFileName,
    ControlDistributedRunSnapshot,
    ControlQueuedCommandSnapshot,
    ControlRunArtifactBundle,
    ControlRunArtifactFileName,
    ControlRunArtifactSummary,
    ControlRunFailureBundle,
    ControlRunSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { RallarBlackBoxTestRecord } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import { decodeJsonValue } from '@shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

export const CONTROL_ARTIFACT_SCHEMA_VERSION = 1;
export const CONTROL_DISTRIBUTED_ARTIFACT_SCHEMA_VERSION = 2;

export type {
    ControlDistributedRunArtifactBaseFileName,
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunArtifactFileName,
    ControlRunArtifactBundle,
    ControlRunArtifactFileName,
    ControlRunArtifactSummary,
    ControlRunFailureBundle
};

const CONTROL_ARTIFACT_FILE_NAMES: readonly ControlRunArtifactFileName[] = [
    'report.json',
    'results.jsonl',
    'events.jsonl',
    'failures.json',
    'metadata.json'
];

function commandById(run: ControlRunSnapshot): Map<string, ControlQueuedCommandSnapshot> {
    return new Map(run.commands.map((command) => [
        command.envelope.commandId,
        command
    ]));
}

function commandAction(command: ControlQueuedCommandSnapshot | undefined): string {
    return command?.envelope.command.kind ?? 'unknown';
}

function commandConnection(command: ControlQueuedCommandSnapshot | undefined): string | undefined {
    const value = command?.envelope.command.kind.startsWith('crdt.') && 'handle' in command.envelope.command
        ? command.envelope.command.handle
        : command?.envelope.command && 'connection' in command.envelope.command
        ? command.envelope.command.connection
        : undefined;
    return typeof value === 'string' ? value : undefined;
}

function commandTransport(command: ControlQueuedCommandSnapshot | undefined): string {
    if (command?.envelope.command.kind.startsWith('crdt.')) {
        return 'CRDT';
    }
    const transport = command?.envelope.command && 'transport' in command.envelope.command
        ? command.envelope.command.transport
        : undefined;
    return typeof transport === 'string' && transport.length > 0 ? transport : 'control';
}

function eventTopic(event: ControlEventEnvelope): string | undefined {
    const payload = event.payload;
    return payload && typeof payload === 'object' && 'topic' in payload &&
            typeof payload.topic === 'string'
        ? payload.topic
        : undefined;
}

function artifactEventKind(
    event: ControlEventEnvelope,
    command: ControlQueuedCommandSnapshot | undefined
): string {
    if (command?.envelope.command.kind.startsWith('crdt.') || eventTopic(event)?.includes('.crdt.')) {
        return 'crdt-diagnostic';
    }
    return 'rtc-diagnostic';
}

interface ArtifactSummarySlices {
    readonly commands?: readonly ControlQueuedCommandSnapshot[];
    readonly results?: readonly ControlResultEnvelope[];
    readonly events?: readonly ControlEventEnvelope[];
    readonly reports?: readonly ControlEventEnvelope[];
}

function artifactSummary(
    run: ControlRunSnapshot,
    input: ArtifactSummarySlices = {}
): ControlRunArtifactSummary {
    const results = input.results ?? run.results;
    const success = results.filter((result) => result.ok).length;
    const failure = results.length - success;
    return {
        total: results.length,
        success,
        failure,
        commandCount: input.commands?.length ?? run.commands.length,
        eventCount: input.events?.length ?? run.events.length,
        agentCount: run.agents.length,
        reportCount: input.reports?.length ?? run.reports.length
    };
}

function resultStatus(result: ControlResultEnvelope): 'SUCCESS' | 'FAILURE' {
    return result.ok ? 'SUCCESS' : 'FAILURE';
}

function resultActual(result: ControlResultEnvelope): ApiJsonValue | undefined {
    return decodeJsonValue(result.ok ? result.result?.value ?? result.result : result.error);
}

function resultRows(
    run: ControlRunSnapshot,
    results: readonly ControlResultEnvelope[] = run.results
): readonly RallarBlackBoxTestRecord[] {
    const commands = commandById(run);
    return results.map((result) => controlResultArtifactRow(result, commands.get(result.commandId)));
}

export function controlResultArtifactRow(
    result: ControlResultEnvelope,
    command?: ControlQueuedCommandSnapshot
): RallarBlackBoxTestRecord {
    return redactRallarBlackBoxValue({
        resultKey: `${result.agentId}:${result.commandId}`,
        name: result.commandId,
        status: resultStatus(result),
        transport: commandTransport(command),
        action: commandAction(command),
        connection: commandConnection(command) ?? result.agentId,
        agentId: result.agentId,
        commandId: result.commandId,
        replayed: result.replayed,
        attribution: result.attribution,
        ok: result.ok,
        actual: resultActual(result)
    });
}

export function controlResultArtifactJsonl(
    result: ControlResultEnvelope,
    command?: ControlQueuedCommandSnapshot
): string {
    return `${JSON.stringify(controlResultArtifactRow(result, command))}\n`;
}

export function controlResultEventArtifactJsonl(
    result: ControlResultEnvelope,
    command?: ControlQueuedCommandSnapshot
): string {
    return `${JSON.stringify(artifactEventFromResult(controlResultArtifactRow(result, command)))}\n`;
}

export function controlEventArtifactJsonl(
    event: ControlEventEnvelope,
    command?: ControlQueuedCommandSnapshot
): string {
    return `${JSON.stringify(artifactEventFromControlEvent(event, command))}\n`;
}

function artifactEventFromResult(row: RallarBlackBoxTestRecord): RallarBlackBoxTestRecord {
    return redactRallarBlackBoxValue({
        kind: 'step-result',
        name: row.name,
        status: row.status,
        transport: row.transport,
        action: row.action,
        connection: row.connection,
        agentId: row.agentId,
        commandId: row.commandId,
        actual: row.actual,
        attribution: row.attribution
    });
}

function artifactEventFromControlEvent(
    event: ControlEventEnvelope,
    command: ControlQueuedCommandSnapshot | undefined
): RallarBlackBoxTestRecord {
    return redactRallarBlackBoxValue({
        kind: artifactEventKind(event, command),
        name: event.eventId ?? event.commandId ?? event.kind,
        status: event.kind,
        transport: commandTransport(command),
        action: commandAction(command),
        agentId: event.agentId,
        connection: commandConnection(command) ?? event.commandId ?? event.agentId,
        commandId: event.commandId,
        atEpochMs: event.atEpochMs,
        value: event.payload
    });
}

function jsonl(values: readonly RallarBlackBoxTestRecord[]): string {
    return values.map((value) => JSON.stringify(value)).join('\n') + (values.length > 0 ? '\n' : '');
}

export function controlRunEventsJsonl(run: ControlRunSnapshot): string {
    return controlRunEventsJsonlFromSlices(run, {
        results: run.results,
        events: run.events
    });
}

interface ControlRunEventSlices {
    readonly results: readonly ControlResultEnvelope[];
    readonly events: readonly ControlEventEnvelope[];
}

function controlRunEventsJsonlFromSlices(
    run: ControlRunSnapshot,
    input: ControlRunEventSlices
): string {
    const rows = resultRows(run, input.results);
    const commands = commandById(run);
    return jsonl([
        ...rows.map(artifactEventFromResult),
        ...input.events.map((event) =>
            artifactEventFromControlEvent(
                event,
                event.commandId ? commands.get(event.commandId) : undefined
            )
        )
    ]);
}

export function controlRunResultsJsonl(run: ControlRunSnapshot): string {
    return jsonl(resultRows(run));
}

export function controlRunFailureBundle(run: ControlRunSnapshot): ControlRunFailureBundle {
    const rows = resultRows(run);
    const failures = rows.filter((row) => row.status === 'FAILURE');
    return {
        summary: artifactSummary(run),
        failures,
        outputs: redactRallarBlackBoxValue({
            runId: run.runId,
            generatedFrom: 'rallar-black-box-control-server',
            agentIds: run.agents.map((agent) => agent.agentId),
            reportCount: run.reports.length
        })
    };
}

function toControlRunArtifactReport(
    run: ControlRunSnapshot,
    rows: readonly RallarBlackBoxTestRecord[],
    summary: ControlRunArtifactSummary
): RallarBlackBoxTestRecord {
    const outputs = redactRallarBlackBoxValue({
        runId: run.runId,
        agents: run.agents.map((agent) => ({
            agentId: agent.agentId,
            connected: agent.connected,
            status: agent.status,
            completedCommands: agent.completedCommandIds.length,
            receivedEvents: agent.receivedEventCount,
            receivedResults: agent.receivedResultCount
        })),
        commandCount: run.commands.length,
        eventCount: run.events.length,
        reportCount: run.reports.length
    });
    return {
        schemaVersion: CONTROL_ARTIFACT_SCHEMA_VERSION,
        artifactSchemaVersion: CONTROL_ARTIFACT_SCHEMA_VERSION,
        summary,
        results: Object.fromEntries(rows.map((row) => [String(row.resultKey), row])),
        resultsList: rows,
        outputs,
        metrics: {
            heartbeats: run.heartbeats.length,
            stats: run.stats.length
        }
    };
}

function toControlRunArtifactMetadata(
    run: ControlRunSnapshot,
    summary: ControlRunArtifactSummary,
    generatedAtEpochMs: number
): RallarBlackBoxTestRecord {
    return {
        schemaVersion: CONTROL_ARTIFACT_SCHEMA_VERSION,
        artifactSchemaVersion: CONTROL_ARTIFACT_SCHEMA_VERSION,
        generatedAtEpochMs,
        config: 'rallar-black-box-control-server',
        execution: 'run',
        summary,
        artifactRefs: {
            eventsJsonl: `/runs/${encodeURIComponent(run.runId)}/events.jsonl`,
            resultsJsonl: `/runs/${encodeURIComponent(run.runId)}/results.jsonl`
        },
        command: [
            'rallar-black-box-control-server',
            'export-run-artifact',
            run.runId
        ]
    };
}

export function createControlRunArtifactBundle(
    run: ControlRunSnapshot,
    generatedAtEpochMs = Date.now()
): ControlRunArtifactBundle {
    const rows = resultRows(run);
    const summary = artifactSummary(run);

    return {
        artifactSchemaVersion: CONTROL_ARTIFACT_SCHEMA_VERSION,
        runId: run.runId,
        generatedAtEpochMs,
        files: {
            'report.json': JSON.stringify(toControlRunArtifactReport(run, rows, summary), null, 2),
            'results.jsonl': controlRunResultsJsonl(run),
            'events.jsonl': controlRunEventsJsonl(run),
            'failures.json': JSON.stringify(controlRunFailureBundle(run), null, 2),
            'metadata.json': JSON.stringify(toControlRunArtifactMetadata(run, summary, generatedAtEpochMs), null, 2)
        }
    };
}

interface DistributedArtifactEvidence {
    readonly linkedCommands: readonly ControlQueuedCommandSnapshot[];
    readonly linkedResults: readonly ControlResultEnvelope[];
    readonly linkedEvents: readonly ControlEventEnvelope[];
    readonly linkedReports: readonly ControlEventEnvelope[];
    readonly summary: ControlRunArtifactSummary;
    readonly resultList: readonly RallarBlackBoxTestRecord[];
}

function toDistributedArtifactEvidence(
    distributedRun: ControlDistributedRunSnapshot,
    controlRun: ControlRunSnapshot | undefined
): DistributedArtifactEvidence {
    const linkedCommandIds = new Set(distributedRun.commandLinks.map((link) => link.commandId));
    const linkedCommands = (controlRun?.commands ?? [])
        .filter((command) => linkedCommandIds.has(command.envelope.commandId));
    const linkedResults = (controlRun?.results ?? [])
        .filter((result) => linkedCommandIds.has(result.commandId));
    const linkedEvents = (controlRun?.events ?? [])
        .filter((event) =>
            (event.commandId !== undefined && linkedCommandIds.has(event.commandId)) ||
            payloadReferencesDistributedRun(decodeJsonValue(event.payload), distributedRun.distributedRunId)
        );
    const linkedReports = (controlRun?.reports ?? [])
        .filter((report) =>
            (report.commandId !== undefined && linkedCommandIds.has(report.commandId)) ||
            payloadReferencesDistributedRun(decodeJsonValue(report.payload), distributedRun.distributedRunId)
        );
    const summary = controlRun
        ? artifactSummary(controlRun, {
            commands: linkedCommands,
            results: linkedResults,
            events: linkedEvents,
            reports: linkedReports
        })
        : {
            total: 0,
            success: 0,
            failure: 0,
            commandCount: linkedCommandIds.size,
            eventCount: 0,
            agentCount: distributedRun.targetAgentIds.length,
            reportCount: 0
        };
    const resultList = controlRun ? resultRows(controlRun, linkedResults) : [];
    return { linkedCommands, linkedResults, linkedEvents, linkedReports, summary, resultList };
}

function toDistributedArtifactOutput(
    distributedRun: ControlDistributedRunSnapshot,
    linkedCommands: readonly ControlQueuedCommandSnapshot[]
): RallarBlackBoxTestRecord {
    return redactRallarBlackBoxValue({
        distributedRunId: distributedRun.distributedRunId,
        controlRunId: distributedRun.controlRunId,
        state: distributedRun.state,
        ok: distributedRun.rollup.ok,
        targetAgentIds: distributedRun.targetAgentIds,
        targetResolution: distributedRun.targetResolution,
        commandLinkCount: distributedRun.commandLinks.length,
        linkedCommandCount: linkedCommands.length,
        generatedFrom: 'rallar-black-box-control-server'
    });
}

interface DistributedArtifactReportInput {
    readonly distributedRun: ControlDistributedRunSnapshot;
    readonly controlRun: ControlRunSnapshot | undefined;
    readonly evidence: DistributedArtifactEvidence;
    readonly output: RallarBlackBoxTestRecord;
}

function toDistributedArtifactReport(input: DistributedArtifactReportInput): RallarBlackBoxTestRecord {
    const { distributedRun, controlRun, evidence, output } = input;
    const { summary, resultList, linkedEvents, linkedReports } = evidence;
    return redactRallarBlackBoxValue({
        schemaVersion: CONTROL_DISTRIBUTED_ARTIFACT_SCHEMA_VERSION,
        artifactSchemaVersion: CONTROL_DISTRIBUTED_ARTIFACT_SCHEMA_VERSION,
        execution: 'distributed-run',
        distributedRunId: distributedRun.distributedRunId,
        controlRunId: distributedRun.controlRunId,
        state: distributedRun.state,
        ok: distributedRun.rollup.ok,
        summary,
        targetResolution: distributedRun.targetResolution,
        distributedSummary: distributedRun.rollup.summary,
        failures: distributedRun.rollup.failures,
        results: Object.fromEntries(resultList.map((row) => [String(row.resultKey), row])),
        resultsList: resultList,
        outputs: output,
        metrics: {
            heartbeats: controlRun?.heartbeats.length ?? 0,
            stats: controlRun?.stats.length ?? 0,
            linkedEvents: linkedEvents.length,
            linkedReports: linkedReports.length
        }
    });
}

function toDistributedArtifactFailures(
    distributedRun: ControlDistributedRunSnapshot,
    evidence: DistributedArtifactEvidence,
    output: RallarBlackBoxTestRecord
): RallarBlackBoxTestRecord {
    const { summary, resultList } = evidence;
    return redactRallarBlackBoxValue({
        summary,
        failures: [
            ...distributedRun.rollup.failures.map((failure) => ({
                source: 'distributed-rollup',
                ...failure
            })),
            ...resultList
                .filter((row) => row.status === 'FAILURE')
                .map((row) => ({
                    source: 'command-result',
                    ...row
                }))
        ],
        outputs: output
    });
}

function toDistributedArtifactMetadata(
    distributedRun: ControlDistributedRunSnapshot,
    summary: ControlRunArtifactSummary,
    generatedAtEpochMs: number
): RallarBlackBoxTestRecord {
    return redactRallarBlackBoxValue({
        schemaVersion: CONTROL_DISTRIBUTED_ARTIFACT_SCHEMA_VERSION,
        artifactSchemaVersion: CONTROL_DISTRIBUTED_ARTIFACT_SCHEMA_VERSION,
        generatedAtEpochMs,
        config: 'rallar-black-box-control-server',
        execution: 'distributed-run',
        summary,
        artifactRefs: {
            eventsJsonl: `/runs/${encodeURIComponent(distributedRun.controlRunId)}/events.jsonl`,
            resultsJsonl: `/runs/${encodeURIComponent(distributedRun.controlRunId)}/results.jsonl`,
            targetResolution: 'target-resolution.json'
        },
        command: [
            'rallar-black-box-control-server',
            'export-distributed-run-artifact',
            distributedRun.distributedRunId
        ]
    });
}

export function createControlDistributedRunArtifactBundle(
    distributedRun: ControlDistributedRunSnapshot,
    controlRun: ControlRunSnapshot | undefined,
    generatedAtEpochMs = Date.now()
): ControlDistributedRunArtifactBundle {
    const evidence = toDistributedArtifactEvidence(distributedRun, controlRun);
    const output = toDistributedArtifactOutput(distributedRun, evidence.linkedCommands);

    return {
        artifactSchemaVersion: CONTROL_DISTRIBUTED_ARTIFACT_SCHEMA_VERSION,
        distributedRunId: distributedRun.distributedRunId,
        generatedAtEpochMs,
        files: {
            'distributed-run.json': JSON.stringify(redactRallarBlackBoxValue(distributedRun), null, 2),
            'manifest.json': JSON.stringify(redactRallarBlackBoxValue(distributedRun.manifest), null, 2),
            'target-resolution.json': JSON.stringify(
                redactRallarBlackBoxValue(distributedRun.targetResolution ?? null),
                null,
                2
            ),
            'control-run.json': JSON.stringify(redactRallarBlackBoxValue(controlRun ?? null), null, 2),
            'report.json': JSON.stringify(
                toDistributedArtifactReport({ distributedRun, controlRun, evidence, output }),
                null,
                2
            ),
            'failures.json': JSON.stringify(toDistributedArtifactFailures(distributedRun, evidence, output), null, 2),
            'metadata.json': JSON.stringify(
                toDistributedArtifactMetadata(distributedRun, evidence.summary, generatedAtEpochMs),
                null,
                2
            )
        }
    };
}

function payloadReferencesDistributedRun(payload: ApiJsonValue | undefined, distributedRunId: string): boolean {
    return payload !== undefined && distributedRunId.length > 0 && JSON.stringify(payload).includes(distributedRunId);
}

export function controlRunArtifactFileNameFromValue(
    value: string
): ControlRunArtifactFileName | undefined {
    return CONTROL_ARTIFACT_FILE_NAMES.find((fileName) => fileName === value);
}

export function controlRunArtifactContentType(fileName: ControlRunArtifactFileName): string {
    return fileName.endsWith('.jsonl') ? 'application/x-ndjson; charset=utf-8' : 'application/json';
}
