import type { ControlRunSnapshot } from '../control-snapshots.ts';
import type { RallarBlackBoxRuntimeDiagnosticPayload } from '../diagnostics.ts';
import {
    distributedRunCorrelatedFailureKeys,
    type DistributedRunMonitorFailureIndex
} from '../distributed-run-monitor-index.ts';
import type {
    RallarBlackBoxTestSeverity,
    RallarBlackBoxTestTransport
} from '../rallar-black-box-test-contracts.ts';
import { decodeFiniteNumber, decodeRecord } from '../runtime/decode-runtime-result-values.ts';
import {
    decodeFirstNonBlankText,
    summarizeDistributedRunPayload,
    toDistributedRunEventSummary,
    toDistributedRunPayloadTopic
} from './distributed-run-payload-summary.ts';
import type {
    DistributedRunRuntimeDiagnosticCounts,
    DistributedRunRuntimeDiagnosticRow
} from './distributed-run-row-contracts.ts';

type ControlEventSnapshot = ControlRunSnapshot['events'][number];

export function distributedRunRuntimeDiagnostics(
    events: readonly ControlEventSnapshot[]
): readonly Omit<DistributedRunRuntimeDiagnosticRow, 'correlatedFailureKeys'>[] {
    return events
        .map((event, index) => distributedRunRuntimeDiagnostic(event, index))
        .filter((row): row is Omit<DistributedRunRuntimeDiagnosticRow, 'correlatedFailureKeys'> => row !== undefined)
        .sort((left, right) => left.atEpochMs - right.atEpochMs || left.eventId.localeCompare(right.eventId));
}

function distributedRunRuntimeDiagnostic(
    event: ControlEventSnapshot,
    index: number
): Omit<DistributedRunRuntimeDiagnosticRow, 'correlatedFailureKeys'> | undefined {
    const runtimeEvent = decodeRecord(event.payload);
    const payload = decodeRuntimeDiagnosticPayload(event.payload);
    if (!payload) {
        return undefined;
    }

    const data = decodeRecord(payload.data);
    const topic = decodeFirstNonBlankText(
        payload.topic,
        runtimeEvent.topic,
        payload.diagnosticTypeId,
        toDistributedRunPayloadTopic(event.payload),
        event.kind
    ) ?? 'runtime.diagnostic';
    const diagnosticTypeId = decodeFirstNonBlankText(payload.diagnosticTypeId, topic) ?? topic;
    const transport = toDiagnosticTransport(decodeFirstNonBlankText(payload.transport, runtimeEvent.transport));
    const severity = toDiagnosticSeverity(decodeFirstNonBlankText(payload.severity, runtimeEvent.severity), event.kind);
    const message = decodeFirstNonBlankText(
        payload.message,
        runtimeEvent.message,
        payload.reason,
        data.message,
        data.reason,
        toDistributedRunEventSummary(event)
    ) ?? topic;
    const payloadSummary = summarizeDistributedRunPayload(
        payload.data ?? payload.payload ?? runtimeEvent.payload ?? event.payload
    );

    return {
        eventId: event.eventId ?? `${event.agentId}-${event.commandId ?? 'diagnostic'}-${index}`,
        atEpochMs: decodeFiniteNumber(payload.atEpochMs) ?? decodeFiniteNumber(runtimeEvent.atEpochMs) ??
            event.atEpochMs,
        severity,
        agentId: event.agentId,
        commandId: decodeFirstNonBlankText(payload.commandId, runtimeEvent.commandId, event.commandId),
        transport,
        topic,
        diagnosticTypeId,
        message,
        summary: toDiagnosticSummary({
            message,
            transport,
            typeId: decodeFirstNonBlankText(payload.typeId, data.typeId),
            topicId: decodeFirstNonBlankText(payload.topicId, data.topicId),
            contextId: decodeFirstNonBlankText(payload.contextId, data.contextId),
            resourceId: decodeFirstNonBlankText(payload.resourceId, data.resourceId),
            payloadSummary
        }),
        payloadSummary,
        ...toDiagnosticContextFields(payload, runtimeEvent, data)
    };
}

function toDiagnosticContextFields(
    payload: Readonly<Record<string, unknown>>,
    runtimeEvent: Readonly<Record<string, unknown>>,
    data: Readonly<Record<string, unknown>>
): Partial<DistributedRunRuntimeDiagnosticRow> {
    return {
        connection: decodeFirstNonBlankText(payload.connection, runtimeEvent.connection),
        actor: decodeFirstNonBlankText(payload.actor, runtimeEvent.actor),
        groupId: decodeFirstNonBlankText(payload.groupId, data.groupId),
        roomId: decodeFirstNonBlankText(payload.roomId, data.roomId),
        laneId: decodeFirstNonBlankText(payload.laneId, data.laneId),
        peerId: decodeFirstNonBlankText(payload.peerId, data.peerId),
        remotePeerId: decodeFirstNonBlankText(payload.remotePeerId, data.remotePeerId),
        senderId: decodeFirstNonBlankText(payload.senderId, data.senderId),
        typeId: decodeFirstNonBlankText(payload.typeId, data.typeId),
        topicId: decodeFirstNonBlankText(payload.topicId, data.topicId),
        contextId: decodeFirstNonBlankText(payload.contextId, data.contextId),
        resourceId: decodeFirstNonBlankText(payload.resourceId, data.resourceId),
        source: decodeFirstNonBlankText(payload.source, runtimeEvent.source)
    };
}

export function correlateDistributedRunRuntimeDiagnostics(
    diagnostics: readonly Omit<DistributedRunRuntimeDiagnosticRow, 'correlatedFailureKeys'>[],
    failureIndex: DistributedRunMonitorFailureIndex
): readonly DistributedRunRuntimeDiagnosticRow[] {
    return diagnostics.map((diagnostic) => ({
        ...diagnostic,
        correlatedFailureKeys: distributedRunCorrelatedFailureKeys(
            diagnostic,
            failureIndex
        )
    }));
}

export function distributedRunRuntimeDiagnosticCounts(
    diagnostics: readonly DistributedRunRuntimeDiagnosticRow[]
): DistributedRunRuntimeDiagnosticCounts {
    return {
        total: diagnostics.length,
        info: diagnostics.filter((row) => row.severity === 'info' || row.severity === 'debug').length,
        warning: diagnostics.filter((row) => row.severity === 'warning').length,
        error: diagnostics.filter((row) => row.severity === 'error').length,
        ws: diagnostics.filter((row) => row.transport === 'ws' || row.transport === 'messages.ws').length,
        rtc: diagnostics.filter((row) => row.transport === 'realtime' || row.transport === 'messages.rtc').length,
        http: diagnostics.filter((row) => row.transport === 'http').length,
        runtime: diagnostics.filter((row) => row.transport === undefined).length
    };
}

function decodeRuntimeDiagnosticPayload(
    payload: unknown
): (RallarBlackBoxRuntimeDiagnosticPayload & Record<string, unknown>) | undefined {
    const envelope = decodeRecord(payload);
    const nested = decodeRecord(envelope.payload);
    if (isCanonicalRuntimeDiagnosticPayload(nested)) {
        return nested as RallarBlackBoxRuntimeDiagnosticPayload & Record<string, unknown>;
    }
    if (isCanonicalRuntimeDiagnosticPayload(envelope)) {
        return envelope as RallarBlackBoxRuntimeDiagnosticPayload & Record<string, unknown>;
    }
    return undefined;
}

function isCanonicalRuntimeDiagnosticPayload(value: Record<string, unknown>): boolean {
    return value.diagnosticSchemaVersion === 1;
}

function toDiagnosticSeverity(
    value: string | undefined,
    eventKind: string
): RallarBlackBoxTestSeverity {
    if (value === 'debug' || value === 'info' || value === 'warning' || value === 'error') {
        return value;
    }
    return eventKind === 'diagnostic' ? 'warning' : 'info';
}

function toDiagnosticTransport(value: string | undefined): RallarBlackBoxTestTransport | undefined {
    if (
        value === 'ws' ||
        value === 'messages.ws' ||
        value === 'http' ||
        value === 'realtime' ||
        value === 'messages.rtc'
    ) {
        return value;
    }
    return undefined;
}

function toDiagnosticSummary(
    input: Readonly<{
        message: string;
        transport?: RallarBlackBoxTestTransport;
        typeId?: string;
        topicId?: string;
        contextId?: string;
        resourceId?: string;
        payloadSummary: string;
    }>
): string {
    const selector = [
        input.typeId ? `type ${input.typeId}` : undefined,
        input.topicId ? `topic ${input.topicId}` : undefined,
        input.contextId ? `context ${input.contextId}` : undefined,
        input.resourceId ? `resource ${input.resourceId}` : undefined
    ].filter(Boolean).join(' / ');
    return [
        input.transport,
        input.message,
        selector,
        input.payloadSummary
    ].filter((value): value is string => Boolean(value && value.length > 0)).join(' - ');
}

export function toDiagnosticSeverityTone(severity: RallarBlackBoxTestSeverity): string {
    if (severity === 'error') {
        return 'bad';
    }
    if (severity === 'warning') {
        return 'warn';
    }
    return 'muted';
}
