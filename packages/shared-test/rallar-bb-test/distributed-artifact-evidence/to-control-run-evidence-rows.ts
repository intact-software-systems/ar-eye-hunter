import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import type { ControlEventEnvelope, ControlResultEnvelope } from '../control-protocol.ts';
import type { ControlDistributedRunSnapshot } from '../control-snapshots.ts';
import type { DistributedRunArtifactSnapshots } from '../distributed-artifact-analysis.ts';
import type {
    DistributedArtifactEvidenceEntry,
    DistributedArtifactEvidenceFailureDetails,
    DistributedArtifactEvidenceKind
} from '../distributed-artifact-evidence-contracts.ts';
import type { DistributedRunMonitor } from '../distributed-run-monitor.ts';
import { hasDistributedRunReference } from '../has-distributed-run-reference.ts';
import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';
import { decodeRecord } from '../runtime/decode-runtime-result-values.ts';
import { toEventEvidenceKey, toStableEvidenceId } from './distributed-artifact-evidence-identity.ts';
import {
    resolveDistributedArtifactEvidenceSourceFile,
    type DistributedArtifactEvidenceSourceFiles
} from './resolve-distributed-artifact-evidence-source-file.ts';

/** The distributed run's command links, which tie control run evidence to its recipes. */
export interface EvidenceCommandLinks {
    /** A command maps to undefined when its link names no recipe. */
    readonly recipeByCommandId: ReadonlyMap<string, string | undefined>;
    /** Empty when the run links no command, so every control run row counts as its evidence. */
    readonly linkedCommandIds: ReadonlySet<string>;
}

export interface ControlRunEvidenceRowsInput extends DistributedArtifactEvidenceSourceFiles {
    readonly snapshots: DistributedRunArtifactSnapshots;
    readonly monitor: DistributedRunMonitor;
    readonly commandLinks: EvidenceCommandLinks;
}

interface ControlRunEventRowSource {
    readonly event: ControlEventEnvelope;
    readonly eventId: string;
    readonly sourceFile: string;
    readonly recipeByCommandId: ReadonlyMap<string, string | undefined>;
}

const FAILURE_DETAIL_FIELDS = ['code', 'name', 'message', 'stack'] as const;
const MAX_NESTED_FAILURE_DETAILS = 4;

export function toEvidenceCommandLinks(distributedRun: ControlDistributedRunSnapshot): EvidenceCommandLinks {
    return {
        recipeByCommandId: new Map(distributedRun.commandLinks.map((link) => [link.commandId, link.recipeId])),
        linkedCommandIds: new Set(distributedRun.commandLinks.map((link) => link.commandId))
    };
}

export function toControlRunResultRows(input: ControlRunEvidenceRowsInput): DistributedArtifactEvidenceEntry[] {
    const sourceFile = resolveDistributedArtifactEvidenceSourceFile(input, 'results', 'results.jsonl');
    const { linkedCommandIds, recipeByCommandId } = input.commandLinks;
    return input.snapshots.controlRun.results
        .filter((result) => linkedCommandIds.size === 0 || linkedCommandIds.has(result.commandId))
        .map((result) => toControlRunResultRow(result, sourceFile, recipeByCommandId));
}

/** Control run events the monitor does not represent, when they belong to a linked command or name the run. */
export function toControlRunEventRows(input: ControlRunEvidenceRowsInput): DistributedArtifactEvidenceEntry[] {
    const represented = new Set([
        ...input.monitor.events.map(toEventEvidenceKey),
        ...input.monitor.runtimeDiagnostics.map(toEventEvidenceKey)
    ]);
    const sourceFile = resolveDistributedArtifactEvidenceSourceFile(input, 'events', 'events.jsonl');
    const { recipeByCommandId } = input.commandLinks;
    return input.snapshots.controlRun.events
        .map((event) => ({
            event,
            eventId: event.eventId ?? `${event.kind}-${event.atEpochMs}`,
            sourceFile,
            recipeByCommandId
        }))
        .filter((source) =>
            !represented.has(toEventEvidenceKey({
                eventId: source.eventId,
                agentId: source.event.agentId,
                commandId: source.event.commandId
            })) &&
            isRunEvidenceEvent(source.event, input)
        )
        .map(toControlRunEventRow);
}

function isRunEvidenceEvent(event: ControlEventEnvelope, input: ControlRunEvidenceRowsInput): boolean {
    const { linkedCommandIds } = input.commandLinks;
    return linkedCommandIds.size === 0 ||
        (event.commandId !== undefined && linkedCommandIds.has(event.commandId)) ||
        hasDistributedRunReference(event, input.snapshots.distributedRun.distributedRunId);
}

function toControlRunResultRow(
    result: ControlResultEnvelope,
    sourceFile: string,
    recipeByCommandId: ReadonlyMap<string, string | undefined>
): DistributedArtifactEvidenceEntry {
    const status = result.result?.status ?? (result.ok ? 'ok' : 'failed');
    const kind = result.result?.kind;
    const failureDetails = status === 'failed'
        ? decodeResultFailureDetails(result.error ?? result.result?.error)
        : undefined;
    return {
        id: toStableEvidenceId(['result', result.agentId, result.commandId, result.result?.endedAtEpochMs]),
        kind: 'result',
        sourceFile,
        atEpochMs: result.result?.endedAtEpochMs,
        agentId: result.agentId,
        agentIds: [result.agentId],
        recipeId: recipeByCommandId.get(result.commandId),
        commandId: result.commandId,
        transport: getTextField(decodeRecord(result.result?.value), 'transport') ?? resolveCommandKindTransport(kind),
        status,
        category: 'command',
        summary: result.error?.message ?? result.result?.error?.message ?? `${kind ?? 'command'} ${status}`,
        payloadSummary: decodeEvidenceValueSummary(
            result.error?.details ?? result.result?.error?.details ?? result.result?.value
        ),
        ...(failureDetails ? { failureDetails } : {})
    };
}

function toControlRunEventRow(source: ControlRunEventRowSource): DistributedArtifactEvidenceEntry {
    const { event } = source;
    const payload = decodeRecord(event.payload);
    const nested = decodeRecord(payload.payload);
    const evidence = Object.keys(nested).length > 0 ? nested : payload;
    const diagnosticType = getTextField(evidence, 'diagnosticTypeId') ?? getTextField(evidence, 'diagnosticType') ??
        getTextField(evidence, 'typeId');
    const topic = getTextField(evidence, 'topic') ?? getTextField(payload, 'topic');
    const kind: DistributedArtifactEvidenceKind = event.kind === 'diagnostic' || diagnosticType
        ? 'diagnostic'
        : 'event';
    return {
        id: toStableEvidenceId([kind, source.eventId, event.agentId, event.commandId, event.atEpochMs]),
        kind,
        sourceFile: source.sourceFile,
        atEpochMs: event.atEpochMs,
        agentId: event.agentId,
        agentIds: [event.agentId],
        recipeId: event.commandId ? source.recipeByCommandId.get(event.commandId) : undefined,
        commandId: event.commandId,
        topic,
        diagnosticType,
        severity: getTextField(evidence, 'severity') ?? getTextField(payload, 'severity'),
        transport: getTextField(evidence, 'transport') ?? getTextField(payload, 'transport'),
        status: kind === 'diagnostic' ? 'diagnostic' : event.kind,
        category: kind,
        summary: getTextField(evidence, 'message') ?? getTextField(payload, 'message') ??
            `${event.kind}${topic ? ` · ${topic}` : ''}`,
        payloadSummary: decodeEvidenceValueSummary(event.payload)
    };
}

/** Each detail comes from the deepest nested `details` record that carries it, at most four levels down. */
function decodeResultFailureDetails(value: unknown): DistributedArtifactEvidenceFailureDetails | undefined {
    const records = toNestedDetailRecords(decodeRecord(value));
    const details = Object.fromEntries(FAILURE_DETAIL_FIELDS.flatMap((field) => {
        const texts = records.flatMap((record) => getTextField(record, field)?.trim() || []);
        const deepest = texts[texts.length - 1];
        return deepest === undefined ? [] : [[field, deepest]];
    }));
    return Object.keys(details).length > 0 ? details : undefined;
}

function toNestedDetailRecords(record: RallarBlackBoxTestRecord): readonly RallarBlackBoxTestRecord[] {
    const records = [record];
    let current = decodeRecord(record.details);
    while (records.length <= MAX_NESTED_FAILURE_DETAILS && Object.keys(current).length > 0) {
        records.push(current);
        current = decodeRecord(current.details);
    }
    return records;
}

function getTextField(record: RallarBlackBoxTestRecord, key: string): string | undefined {
    const value = record[key];
    return typeof value === 'string' ? value : undefined;
}

function resolveCommandKindTransport(kind: string | undefined): string | undefined {
    if (kind?.startsWith('rtc.')) {
        return 'rtc';
    }
    if (kind?.startsWith('ws.')) {
        return 'ws';
    }
    return kind?.startsWith('http.') ? 'http' : undefined;
}

/** Text stays as recorded; any other value is its JSON text with object keys sorted, or its string form without one. */
function decodeEvidenceValueSummary(value: unknown): string {
    if (value === undefined) {
        return '';
    }
    if (typeof value === 'string') {
        return value;
    }
    try {
        return JSON.stringify(value, (_key, nested: ApiJsonValue) => toSortedJsonObject(nested));
    }
    catch {
        return String(value);
    }
}

function toSortedJsonObject(value: ApiJsonValue): ApiJsonValue {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return value;
    }
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}
