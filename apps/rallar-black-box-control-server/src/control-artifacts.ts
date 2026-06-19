import type {
  ControlEventEnvelope,
  ControlResultEnvelope,
} from '../../rallar-black-box/src/control-protocol.ts';
import type {
  ControlDistributedRunSnapshot,
  ControlQueuedCommandSnapshot,
  ControlRunSnapshot,
} from './control-service.ts';
import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';

export const CONTROL_ARTIFACT_SCHEMA_VERSION = 1;
export const CONTROL_DISTRIBUTED_ARTIFACT_SCHEMA_VERSION = 2;

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

export type ControlDistributedRunArtifactFileName =
  | 'distributed-run.json'
  | 'manifest.json'
  | 'control-run.json'
  | 'report.json'
  | 'results.jsonl'
  | 'events.jsonl'
  | 'failures.json'
  | 'metadata.json';

export type ControlDistributedRunArtifactBaseFileName =
  | 'distributed-run.json'
  | 'manifest.json'
  | 'control-run.json';

export type ControlDistributedRunArtifactBundle = Readonly<{
  artifactSchemaVersion: 1 | typeof CONTROL_DISTRIBUTED_ARTIFACT_SCHEMA_VERSION;
  distributedRunId: string;
  generatedAtEpochMs: number;
  files: Readonly<
    & Record<ControlDistributedRunArtifactBaseFileName, string>
    & Partial<Record<ControlDistributedRunArtifactFileName, string>>
  >;
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
  return new Map(run.commands.map((command) => [
    command.envelope.commandId,
    command,
  ]));
}

function commandAction(command: ControlQueuedCommandSnapshot | undefined): string {
  return command?.envelope.command.kind ?? 'unknown';
}

function commandConnection(command: ControlQueuedCommandSnapshot | undefined): unknown {
  if (command?.envelope.command.kind.startsWith('crdt.') && 'handle' in command.envelope.command) {
    return command.envelope.command.handle;
  }
  return command?.envelope.command && 'connection' in command.envelope.command
    ? command.envelope.command.connection
    : undefined;
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
  command: ControlQueuedCommandSnapshot | undefined,
): string {
  if (command?.envelope.command.kind.startsWith('crdt.') || eventTopic(event)?.includes('.crdt.')) {
    return 'crdt-diagnostic';
  }
  return 'rtc-diagnostic';
}

function redact<T>(value: T): T {
  return redactRallarBlackBoxValue(value);
}

function artifactSummary(
  run: ControlRunSnapshot,
  input: Readonly<{
    commands?: readonly ControlQueuedCommandSnapshot[];
    results?: readonly ControlResultEnvelope[];
    events?: readonly ControlEventEnvelope[];
    reports?: readonly ControlEventEnvelope[];
  }> = {},
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
    reportCount: input.reports?.length ?? run.reports.length,
  };
}

function resultStatus(result: ControlResultEnvelope): 'SUCCESS' | 'FAILURE' {
  return result.ok ? 'SUCCESS' : 'FAILURE';
}

function resultActual(result: ControlResultEnvelope): unknown {
  return result.ok ? result.result?.value ?? result.result : result.error;
}

function resultRows(
  run: ControlRunSnapshot,
  results: readonly ControlResultEnvelope[] = run.results,
): readonly Record<string, unknown>[] {
  const commands = commandById(run);
  return results.map((result) => {
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

function artifactEventFromControlEvent(
  event: ControlEventEnvelope,
  command: ControlQueuedCommandSnapshot | undefined,
): Record<string, unknown> {
  return redact({
    kind: artifactEventKind(event, command),
    name: event.eventId ?? event.commandId ?? event.kind,
    status: event.kind,
    transport: commandTransport(command),
    action: commandAction(command),
    agentId: event.agentId,
    connection: commandConnection(command) ?? event.commandId ?? event.agentId,
    commandId: event.commandId,
    atEpochMs: event.atEpochMs,
    value: event.payload,
  });
}

function jsonl(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join('\n') + (values.length > 0 ? '\n' : '');
}

export function controlRunEventsJsonl(run: ControlRunSnapshot): string {
  return controlRunEventsJsonlFromSlices(run, {
    results: run.results,
    events: run.events,
  });
}

function controlRunEventsJsonlFromSlices(
  run: ControlRunSnapshot,
  input: Readonly<{
    results: readonly ControlResultEnvelope[];
    events: readonly ControlEventEnvelope[];
  }>,
): string {
  const rows = resultRows(run, input.results);
  const commands = commandById(run);
  return jsonl([
    ...rows.map(artifactEventFromResult),
    ...input.events.map((event) =>
      artifactEventFromControlEvent(
        event,
        event.commandId ? commands.get(event.commandId) : undefined,
      )
    ),
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
    outputs: redact({
      runId: run.runId,
      generatedFrom: 'rallar-black-box-control-server',
      agentIds: run.agents.map((agent) => agent.agentId),
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
    agents: run.agents.map((agent) => ({
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
    results: Object.fromEntries(rows.map((row) => [String(row.resultKey), row])),
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

export function createControlDistributedRunArtifactBundle(
  distributedRun: ControlDistributedRunSnapshot,
  controlRun: ControlRunSnapshot | undefined,
  generatedAtEpochMs = Date.now(),
): ControlDistributedRunArtifactBundle {
  const linkedCommandIds = new Set(distributedRun.commandLinks.map((link) => link.commandId));
  const linkedCommands = (controlRun?.commands ?? [])
    .filter((command) => linkedCommandIds.has(command.envelope.commandId));
  const linkedResults = (controlRun?.results ?? [])
    .filter((result) => linkedCommandIds.has(result.commandId));
  const linkedEvents = (controlRun?.events ?? [])
    .filter((event) =>
      (event.commandId !== undefined && linkedCommandIds.has(event.commandId)) ||
      payloadReferencesDistributedRun(event.payload, distributedRun.distributedRunId)
    );
  const linkedReports = (controlRun?.reports ?? [])
    .filter((report) =>
      (report.commandId !== undefined && linkedCommandIds.has(report.commandId)) ||
      payloadReferencesDistributedRun(report.payload, distributedRun.distributedRunId)
    );
  const summary = controlRun
    ? artifactSummary(controlRun, {
      commands: linkedCommands,
      results: linkedResults,
      events: linkedEvents,
      reports: linkedReports,
    })
    : {
      total: 0,
      success: 0,
      failure: 0,
      commandCount: linkedCommandIds.size,
      eventCount: 0,
      agentCount: distributedRun.targetAgentIds.length,
      reportCount: 0,
    };
  const resultList = controlRun ? resultRows(controlRun, linkedResults) : [];
  const output = redact({
    distributedRunId: distributedRun.distributedRunId,
    controlRunId: distributedRun.controlRunId,
    state: distributedRun.state,
    ok: distributedRun.rollup.ok,
    targetAgentIds: distributedRun.targetAgentIds,
    commandLinkCount: distributedRun.commandLinks.length,
    linkedCommandCount: linkedCommands.length,
    generatedFrom: 'rallar-black-box-control-server',
  });
  const report = redact({
    schemaVersion: CONTROL_DISTRIBUTED_ARTIFACT_SCHEMA_VERSION,
    artifactSchemaVersion: CONTROL_DISTRIBUTED_ARTIFACT_SCHEMA_VERSION,
    execution: 'distributed-run',
    distributedRunId: distributedRun.distributedRunId,
    controlRunId: distributedRun.controlRunId,
    state: distributedRun.state,
    ok: distributedRun.rollup.ok,
    summary,
    distributedSummary: distributedRun.rollup.summary,
    failures: distributedRun.rollup.failures,
    results: Object.fromEntries(resultList.map((row) => [String(row.resultKey), row])),
    resultsList: resultList,
    outputs: output,
    metrics: {
      heartbeats: controlRun?.heartbeats.length ?? 0,
      stats: controlRun?.stats.length ?? 0,
      linkedEvents: linkedEvents.length,
      linkedReports: linkedReports.length,
    },
  });
  const failures = redact({
    summary,
    failures: [
      ...distributedRun.rollup.failures.map((failure) => ({
        source: 'distributed-rollup',
        ...failure,
      })),
      ...resultList
        .filter((row) => row.status === 'FAILURE')
        .map((row) => ({
          source: 'command-result',
          ...row,
        })),
    ],
    outputs: output,
  });
  const metadata = redact({
    schemaVersion: CONTROL_DISTRIBUTED_ARTIFACT_SCHEMA_VERSION,
    artifactSchemaVersion: CONTROL_DISTRIBUTED_ARTIFACT_SCHEMA_VERSION,
    generatedAtEpochMs,
    config: 'rallar-black-box-control-server',
    execution: 'distributed-run',
    summary,
    command: [
      'rallar-black-box-control-server',
      'export-distributed-run-artifact',
      distributedRun.distributedRunId,
    ],
  });

  return {
    artifactSchemaVersion: CONTROL_DISTRIBUTED_ARTIFACT_SCHEMA_VERSION,
    distributedRunId: distributedRun.distributedRunId,
    generatedAtEpochMs,
    files: {
      'distributed-run.json': JSON.stringify(redact(distributedRun), null, 2),
      'manifest.json': JSON.stringify(redact(distributedRun.manifest), null, 2),
      'control-run.json': JSON.stringify(redact(controlRun ?? null), null, 2),
      'report.json': JSON.stringify(report, null, 2),
      'results.jsonl': controlRun ? jsonl(resultList) : '',
      'events.jsonl': controlRun
        ? controlRunEventsJsonlFromSlices(controlRun, {
          results: linkedResults,
          events: linkedEvents,
        })
        : '',
      'failures.json': JSON.stringify(failures, null, 2),
      'metadata.json': JSON.stringify(metadata, null, 2),
    },
  };
}

function payloadReferencesDistributedRun(payload: unknown, distributedRunId: string): boolean {
  if (!payload || !distributedRunId) {
    return false;
  }
  try {
    return JSON.stringify(payload).includes(distributedRunId);
  } catch (_error) {
    return false;
  }
}

export function controlRunArtifactFileNameFromValue(
  value: string,
): ControlRunArtifactFileName | undefined {
  return CONTROL_ARTIFACT_FILE_NAMES.includes(value as ControlRunArtifactFileName)
    ? value as ControlRunArtifactFileName
    : undefined;
}

export function controlRunArtifactContentType(fileName: ControlRunArtifactFileName): string {
  return fileName.endsWith('.jsonl') ? 'application/x-ndjson; charset=utf-8' : 'application/json';
}
