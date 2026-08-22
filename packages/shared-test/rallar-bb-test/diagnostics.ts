import { redactRallarBlackBoxValue } from './redaction.ts';
import type {
    RallarBlackBoxTestRedactionOptions,
    RallarBlackBoxTestSeverity,
    RallarBlackBoxTestTransport
} from './types.ts';

export const RALLAR_BLACK_BOX_RUNTIME_DIAGNOSTIC_SCHEMA_VERSION = 1;

export type RallarBlackBoxRuntimeDiagnosticPayload =
    & Readonly<{
        diagnosticSchemaVersion: typeof RALLAR_BLACK_BOX_RUNTIME_DIAGNOSTIC_SCHEMA_VERSION;
        diagnosticTypeId: string;
        topic: string;
        severity: RallarBlackBoxTestSeverity;
        message: string;
        transport?: RallarBlackBoxTestTransport;
        commandId?: string;
        connection?: string;
        actor?: string;
        groupId?: string;
        roomId?: string;
        laneId?: string;
        peerId?: string;
        remotePeerId?: string;
        senderId?: string;
        typeId?: string;
        topicId?: string;
        contextId?: string;
        resourceId?: string;
        atEpochMs?: number;
        data?: unknown;
        error?: unknown;
        source?: string;
    }>
    & Readonly<Record<string, unknown>>;

export type NormalizeRallarBlackBoxRuntimeDiagnosticInput = Readonly<{
    topic: string;
    severity?: RallarBlackBoxTestSeverity;
    transport?: RallarBlackBoxTestTransport;
    commandId?: string;
    connection?: string;
    actor?: string;
    groupId?: string;
    roomId?: string;
    laneId?: string;
    peerId?: string;
    remotePeerId?: string;
    senderId?: string;
    typeId?: string;
    topicId?: string;
    contextId?: string;
    resourceId?: string;
    atEpochMs?: number;
    message?: string;
    data?: unknown;
    error?: unknown;
    source?: string;
    payload?: unknown;
    redaction?: RallarBlackBoxTestRedactionOptions;
}>;

export function inferRallarBlackBoxDiagnosticSeverity(
    input: Readonly<{
        topic: string;
        severity?: RallarBlackBoxTestSeverity;
        error?: unknown;
        data?: unknown;
        payload?: unknown;
    }>
): RallarBlackBoxTestSeverity {
    if (input.severity) {
        return input.severity;
    }
    if (input.error) {
        return 'error';
    }

    const topic = input.topic.toLowerCase();
    if (
        topic.includes('failed') ||
        topic.includes('failure') ||
        topic.includes('error') ||
        topic.includes('timeout') ||
        topic.includes('exception')
    ) {
        return 'error';
    }
    if (
        topic.includes('warning') ||
        topic.includes('warn') ||
        topic.includes('mismatch') ||
        topic.includes('not_open') ||
        topic.includes('not-open') ||
        topic.includes('not_found') ||
        topic.includes('not-found') ||
        topic.includes('no_peers') ||
        topic.includes('no-peers') ||
        topic.includes('attention') ||
        topic.includes('ignored') ||
        topic.includes('closed') ||
        topic.includes('duplicate') ||
        topic.includes('stale')
    ) {
        return 'warning';
    }

    const record = asRecord(input.payload ?? input.data);
    const status = stringValue(record.status)?.toLowerCase();
    if (status === 'failed' || status === 'error' || status === 'timeout') {
        return 'error';
    }
    if (
        status === 'no-peers' ||
        status === 'no-route' ||
        status === 'closed' ||
        status === 'dropped' ||
        status === 'skipped'
    ) {
        return 'warning';
    }

    return 'info';
}

export function normalizeRallarBlackBoxRuntimeDiagnostic(
    input: NormalizeRallarBlackBoxRuntimeDiagnosticInput
): RallarBlackBoxRuntimeDiagnosticPayload {
    const payloadRecord = asRecord(input.payload);
    const dataRecord = asRecord(input.data);
    const merged = {
        ...payloadRecord,
        ...definedRecord({
            transport: input.transport,
            commandId: input.commandId,
            connection: input.connection,
            actor: input.actor,
            groupId: input.groupId ?? stringValue(payloadRecord.groupId),
            roomId: input.roomId ?? stringValue(payloadRecord.roomId),
            laneId: input.laneId ?? stringValue(payloadRecord.laneId),
            peerId: input.peerId ?? stringValue(payloadRecord.peerId),
            remotePeerId: input.remotePeerId ?? stringValue(payloadRecord.remotePeerId),
            senderId: input.senderId ?? stringValue(payloadRecord.senderId),
            typeId: input.typeId ?? stringValue(payloadRecord.typeId),
            topicId: input.topicId ?? stringValue(payloadRecord.topicId),
            contextId: input.contextId ?? stringValue(payloadRecord.contextId),
            resourceId: input.resourceId ?? stringValue(payloadRecord.resourceId)
        })
    };
    const severity = inferRallarBlackBoxDiagnosticSeverity({
        topic: input.topic,
        severity: input.severity ?? toSeverity(payloadRecord.severity),
        error: input.error ?? payloadRecord.error,
        data: input.data,
        payload: input.payload
    });
    const data = input.data !== undefined
        ? input.data
        : payloadRecord.data !== undefined
        ? payloadRecord.data
        : input.payload;
    const error = input.error ?? payloadRecord.error;
    const typeId = stringValue(input.typeId ?? payloadRecord.typeId ?? dataRecord.typeId);
    const topicId = stringValue(input.topicId ?? payloadRecord.topicId ?? dataRecord.topicId);
    const diagnostic = {
        ...merged,
        diagnosticSchemaVersion: RALLAR_BLACK_BOX_RUNTIME_DIAGNOSTIC_SCHEMA_VERSION,
        diagnosticTypeId: input.topic,
        topic: input.topic,
        severity,
        message: input.message ?? diagnosticMessage(input.topic, input.payload, data, error),
        ...(input.transport !== undefined ? { transport: input.transport } : {}),
        ...(input.commandId !== undefined ? { commandId: input.commandId } : {}),
        ...(input.connection !== undefined ? { connection: input.connection } : {}),
        ...(input.actor !== undefined ? { actor: input.actor } : {}),
        ...(input.atEpochMs !== undefined ? { atEpochMs: input.atEpochMs } : {}),
        ...(data !== undefined ? { data } : {}),
        ...(error !== undefined ? { error } : {}),
        ...(input.source !== undefined ? { source: input.source } : {}),
        ...(typeId !== undefined ? { typeId } : {}),
        ...(topicId !== undefined ? { topicId } : {})
    } satisfies RallarBlackBoxRuntimeDiagnosticPayload;

    return redactRallarBlackBoxValue(diagnostic, input.redaction);
}

function diagnosticMessage(
    topic: string,
    payload: unknown,
    data: unknown,
    error: unknown
): string {
    const errorRecord = asRecord(error);
    const payloadRecord = asRecord(payload);
    const dataRecord = asRecord(data);
    return stringValue(errorRecord.message) ??
        stringValue(payloadRecord.message) ??
        stringValue(payloadRecord.reason) ??
        stringValue(dataRecord.message) ??
        stringValue(dataRecord.reason) ??
        topic;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
        ? value
        : undefined;
}

function toSeverity(value: unknown): RallarBlackBoxTestSeverity | undefined {
    return value === 'debug' || value === 'info' || value === 'warning' || value === 'error'
        ? value
        : undefined;
}

function definedRecord(
    value: Record<string, unknown>
): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(value).filter(([_key, entry]) => entry !== undefined)
    );
}
