import type {
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestSeverity,
    RallarBlackBoxTestTransport
} from './rallar-black-box-test-contracts.ts';
import { redactRallarBlackBoxValue } from './redaction.ts';
import { decodeNonBlankText, decodeRecord } from './runtime/decode-runtime-result-values.ts';

export const RALLAR_BLACK_BOX_RUNTIME_DIAGNOSTIC_SCHEMA_VERSION = 1;

/** A value a producer reports as evidence; a diagnostic keeps it as reported until redaction. */
export type RallarBlackBoxRuntimeDiagnosticEvidence = object | string | number | boolean | null;

/** What a diagnostic concerns; each fact is absent when the diagnostic does not concern it. */
export interface RallarBlackBoxRuntimeDiagnosticSubject {
    /** Absent when the diagnostic concerns no single transport. */
    readonly transport?: RallarBlackBoxTestTransport;
    /** Absent when no command raised the diagnostic. */
    readonly commandId?: string;
    /** Absent when the diagnostic concerns no named connection. */
    readonly connection?: string;
    /** Absent when the diagnostic names no acting principal. */
    readonly actor?: string;
    /** Absent when the diagnostic concerns no group. */
    readonly groupId?: string;
    /** Absent when the diagnostic concerns no room. */
    readonly roomId?: string;
    /** Absent when the diagnostic concerns no realtime lane. */
    readonly laneId?: string;
    /** Absent when the diagnostic concerns no local peer. */
    readonly peerId?: string;
    /** Absent when the diagnostic concerns no remote peer. */
    readonly remotePeerId?: string;
    /** Absent when the diagnostic concerns no message sender. */
    readonly senderId?: string;
    /** Absent when the diagnostic concerns no message type. */
    readonly typeId?: string;
    /** Absent when the diagnostic concerns no message topic. */
    readonly topicId?: string;
    /** Absent when the diagnostic concerns no message context. */
    readonly contextId?: string;
    /** Absent when the diagnostic concerns no resource. */
    readonly resourceId?: string;
}

/** A runtime diagnostic event payload; the keys of the producer's payload record ride beside these fields. */
export interface RallarBlackBoxRuntimeDiagnosticPayload extends RallarBlackBoxRuntimeDiagnosticSubject {
    readonly diagnosticSchemaVersion: typeof RALLAR_BLACK_BOX_RUNTIME_DIAGNOSTIC_SCHEMA_VERSION;
    readonly diagnosticTypeId: string;
    readonly topic: string;
    readonly severity: RallarBlackBoxTestSeverity;
    readonly message: string;
    /** Absent when the diagnostic happened when its runtime event was recorded. */
    readonly atEpochMs?: number;
    /** Absent when the producer reported neither a detail nor a payload. */
    readonly data?: RallarBlackBoxRuntimeDiagnosticEvidence;
    /** Absent when no error was reported. */
    readonly error?: RallarBlackBoxRuntimeDiagnosticEvidence;
    readonly source: string;
}

export interface RallarBlackBoxRuntimeDiagnosticInput extends RallarBlackBoxRuntimeDiagnosticSubject {
    readonly topic: string;
    readonly severity: RallarBlackBoxTestSeverity;
    /** Absent when the error, the payload, the detail or else the topic explains the diagnostic. */
    readonly message?: string;
    /** Absent when the diagnostic happened when its runtime event was recorded. */
    readonly atEpochMs?: number;
    /** Absent when the payload's data field, or else the payload itself, is the detail. */
    readonly detail?: RallarBlackBoxRuntimeDiagnosticEvidence;
    /** Absent when the payload's error field reports the error, or no error happened. */
    readonly error?: RallarBlackBoxRuntimeDiagnosticEvidence;
    readonly source: string;
    /** Absent when the producer reports only a detail; a payload record's keys ride beside the diagnostic's fields. */
    readonly payload?: RallarBlackBoxRuntimeDiagnosticEvidence;
}

export interface RallarBlackBoxDiagnosticSeverityInput {
    readonly topic: string;
    /** Absent when the producer leaves the severity to the error, the topic and the reported status. */
    readonly severity?: RallarBlackBoxTestSeverity;
    /** Absent when no error was reported. */
    readonly error?: RallarBlackBoxRuntimeDiagnosticEvidence;
    /** Absent when the producer reported no detail. */
    readonly detail?: RallarBlackBoxRuntimeDiagnosticEvidence;
    /** Absent when the producer reported no payload. */
    readonly payload?: RallarBlackBoxRuntimeDiagnosticEvidence;
}

interface DiagnosticMessageEvidence {
    readonly topic: string;
    readonly payload: RallarBlackBoxRuntimeDiagnosticEvidence | undefined;
    readonly detail: RallarBlackBoxRuntimeDiagnosticEvidence | undefined;
    readonly error: RallarBlackBoxRuntimeDiagnosticEvidence | undefined;
}

const ERROR_TOPIC_WORDS = ['failed', 'failure', 'error', 'timeout', 'exception'];
const WARNING_TOPIC_WORDS = [
    'warning',
    'warn',
    'mismatch',
    'not_open',
    'not-open',
    'not_found',
    'not-found',
    'no_peers',
    'no-peers',
    'attention',
    'ignored',
    'closed',
    'duplicate',
    'stale'
];
const ERROR_STATUSES = ['failed', 'error', 'timeout'];
const WARNING_STATUSES = ['no-peers', 'no-route', 'closed', 'dropped', 'skipped'];

export function computeRallarBlackBoxDiagnosticSeverity(
    input: RallarBlackBoxDiagnosticSeverityInput
): RallarBlackBoxTestSeverity {
    if (input.severity) {
        return input.severity;
    }
    if (input.error) {
        return 'error';
    }

    const topic = input.topic.toLowerCase();
    if (ERROR_TOPIC_WORDS.some((word) => topic.includes(word))) {
        return 'error';
    }
    if (WARNING_TOPIC_WORDS.some((word) => topic.includes(word))) {
        return 'warning';
    }

    const status = decodeNonBlankText(decodeRecord(input.payload ?? input.detail).status)?.toLowerCase() ?? '';
    if (ERROR_STATUSES.includes(status)) {
        return 'error';
    }
    return WARNING_STATUSES.includes(status) ? 'warning' : 'info';
}

export function toRallarBlackBoxRuntimeDiagnostic(
    input: RallarBlackBoxRuntimeDiagnosticInput
): RallarBlackBoxRuntimeDiagnosticPayload {
    const payloadRecord = decodeRecord(input.payload);
    const detail = toDiagnosticDetail(input, payloadRecord);
    const error = input.error ?? decodeRallarBlackBoxRuntimeDiagnosticEvidence(payloadRecord.error);
    const typeId = decodeNonBlankText(input.typeId ?? payloadRecord.typeId ?? decodeRecord(input.detail).typeId);
    const topicId = decodeNonBlankText(input.topicId ?? payloadRecord.topicId ?? decodeRecord(input.detail).topicId);
    return redactRallarBlackBoxValue({
        ...payloadRecord,
        ...toDefinedSubject(input, payloadRecord),
        diagnosticSchemaVersion: RALLAR_BLACK_BOX_RUNTIME_DIAGNOSTIC_SCHEMA_VERSION,
        diagnosticTypeId: input.topic,
        topic: input.topic,
        severity: input.severity,
        message: input.message ?? toDiagnosticMessage({ topic: input.topic, payload: input.payload, detail, error }),
        ...(input.atEpochMs !== undefined ? { atEpochMs: input.atEpochMs } : {}),
        ...(detail !== undefined ? { data: detail } : {}),
        ...(error !== undefined ? { error } : {}),
        source: input.source,
        ...(typeId !== undefined ? { typeId } : {}),
        ...(topicId !== undefined ? { topicId } : {})
    });
}

export function decodeRallarBlackBoxRuntimeDiagnosticEvidence(
    value: unknown
): RallarBlackBoxRuntimeDiagnosticEvidence | undefined {
    return typeof value === 'object' ||
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean'
        ? value
        : undefined;
}

/** A null detail is reported evidence, so only an absent detail falls back to the payload's data and then the payload. */
function toDiagnosticDetail(
    input: RallarBlackBoxRuntimeDiagnosticInput,
    payloadRecord: RallarBlackBoxTestRecord
): RallarBlackBoxRuntimeDiagnosticEvidence | undefined {
    if (input.detail !== undefined) {
        return input.detail;
    }
    const payloadData = decodeRallarBlackBoxRuntimeDiagnosticEvidence(payloadRecord.data);
    return payloadData !== undefined ? payloadData : input.payload;
}

function toDefinedSubject(
    input: RallarBlackBoxRuntimeDiagnosticInput,
    payloadRecord: RallarBlackBoxTestRecord
): RallarBlackBoxRuntimeDiagnosticSubject {
    const subject: RallarBlackBoxRuntimeDiagnosticSubject = {
        transport: input.transport,
        commandId: input.commandId,
        connection: input.connection,
        actor: input.actor,
        groupId: input.groupId ?? decodeNonBlankText(payloadRecord.groupId),
        roomId: input.roomId ?? decodeNonBlankText(payloadRecord.roomId),
        laneId: input.laneId ?? decodeNonBlankText(payloadRecord.laneId),
        peerId: input.peerId ?? decodeNonBlankText(payloadRecord.peerId),
        remotePeerId: input.remotePeerId ?? decodeNonBlankText(payloadRecord.remotePeerId),
        senderId: input.senderId ?? decodeNonBlankText(payloadRecord.senderId),
        typeId: input.typeId ?? decodeNonBlankText(payloadRecord.typeId),
        topicId: input.topicId ?? decodeNonBlankText(payloadRecord.topicId),
        contextId: input.contextId ?? decodeNonBlankText(payloadRecord.contextId),
        resourceId: input.resourceId ?? decodeNonBlankText(payloadRecord.resourceId)
    };
    return Object.fromEntries(
        Object.entries(subject).filter(([_key, fact]) => fact !== undefined)
    ) as RallarBlackBoxRuntimeDiagnosticSubject;
}

function toDiagnosticMessage(evidence: DiagnosticMessageEvidence): string {
    const payloadRecord = decodeRecord(evidence.payload);
    const detailRecord = decodeRecord(evidence.detail);
    return decodeNonBlankText(decodeRecord(evidence.error).message) ??
        decodeNonBlankText(payloadRecord.message) ??
        decodeNonBlankText(payloadRecord.reason) ??
        decodeNonBlankText(detailRecord.message) ??
        decodeNonBlankText(detailRecord.reason) ??
        evidence.topic;
}
