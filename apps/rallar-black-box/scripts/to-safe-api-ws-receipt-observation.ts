import type { ApiJsonObject, ApiJsonValue } from '../../../packages/shared/api/api-json-value.ts';

export interface SafeApiWsReceiptObservationDto extends ApiJsonObject {
    readonly kind: 'socket-decision' | 'ack-count' | 'ack-relay' | 'receipt-outbox';
    readonly serverPeerId: string;
}

export function toSafeApiWsReceiptObservation(value: unknown): SafeApiWsReceiptObservationDto | undefined {
    if (!isApiTimingRecord(value) || !isSafeApiTimingIdentity(value.serverPeerId)) {
        return undefined;
    }
    switch (value.kind) {
        case 'socket-decision':
            return toSafeSocketDecision(value);
        case 'ack-count':
            return toSafeAckCount(value);
        case 'ack-relay':
            return toSafeAckRelay(value);
        case 'receipt-outbox':
            return toSafeReceiptOutbox(value);
        default:
            return undefined;
    }
}

function toSafeSocketDecision(record: Readonly<Record<string, unknown>>): SafeApiWsReceiptObservationDto | undefined {
    const ack = toSafeAck(record.ack);
    if (
        !ack || !isSafeApiTimingIdentity(record.connectionId) ||
        !isAllowedApiTimingString(record.scopeDisposition, ['authorized', 'refused', 'unobserved']) ||
        !isAllowedApiTimingString(record.outcome, [
            'rejected',
            'admitted',
            'duplicate',
            'resync-required',
            'disposed',
            'pending-admission',
            'not-admitted',
            'control'
        ])
    ) {
        return undefined;
    }
    const fields: Record<string, ApiJsonValue> = {};
    retainSafeIdentity(fields, record, 'fromPeerId');
    retainSafeNumber(fields, record, 'scopeAtEpochMs');
    retainSafeRejection(fields, record);
    if (typeof record.handled === 'boolean') {
        fields.handled = record.handled;
    }
    if (record.authenticatedScope !== undefined) {
        const scope = record.authenticatedScope;
        if (
            !isApiTimingRecord(scope) || !isSafeApiTimingIdentity(scope.applicationId) ||
            !isSafeApiTimingIdentity(scope.workspaceId)
        ) {
            return undefined;
        }
        fields.authenticatedScope = { applicationId: scope.applicationId, workspaceId: scope.workspaceId };
    }
    return {
        ...toSafeAckIdentity(record, 'socket-decision', ack),
        ...fields,
        connectionId: record.connectionId,
        scopeDisposition: record.scopeDisposition,
        outcome: record.outcome
    };
}

function toSafeAckCount(record: Readonly<Record<string, unknown>>): SafeApiWsReceiptObservationDto | undefined {
    const ack = toSafeAck(record.ack);
    const before = record.before === undefined ? undefined : toSafeAggregate(record.before);
    const after = record.after === undefined ? undefined : toSafeAggregate(record.after);
    if (
        !ack || !isAllowedApiTimingString(record.source, ['local', 'relayed', 'direct']) ||
        !isAllowedApiTimingString(record.outcome, ['rejected', 'partial', 'complete']) ||
        !isNonNegativeApiTimingNumber(record.countAtEpochMs) ||
        (record.before !== undefined && before === undefined) || (record.after !== undefined && after === undefined)
    ) {
        return undefined;
    }
    const fields: Record<string, ApiJsonValue> = {};
    if (before !== undefined) {
        fields.before = before;
    }
    if (after !== undefined) {
        fields.after = after;
    }
    retainSafeIdentity(fields, record, 'relayPublisherId');
    retainSafeRejection(fields, record);
    return {
        ...toSafeAckIdentity(record, 'ack-count', ack),
        ...fields,
        source: record.source,
        outcome: record.outcome,
        countAtEpochMs: record.countAtEpochMs
    };
}

function toSafeAckRelay(record: Readonly<Record<string, unknown>>): SafeApiWsReceiptObservationDto | undefined {
    const ack = toSafeAck(record.ack);
    if (
        !ack ||
        !isAllowedApiTimingString(record.outcome, [
            'provenance-refused',
            'budget-refused',
            'published',
            'publication-failed'
        ])
    ) {
        return undefined;
    }
    return { ...toSafeAckIdentity(record, 'ack-relay', ack), outcome: record.outcome };
}

function toSafeReceiptOutbox(record: Readonly<Record<string, unknown>>): SafeApiWsReceiptObservationDto | undefined {
    const receipt = toSafeReceipt(record.receipt);
    const verdict = toSafeOutboxVerdict(record.verdict);
    if (
        !receipt || !verdict || !isSafeApiTimingIdentity(record.receiptControlMsgId) ||
        !isNonNegativeApiTimingNumber(record.deadlineAtMs) || !isNonNegativeApiTimingNumber(record.entryCount) ||
        !isAllowedApiTimingString(record.trackedReceiptAlgo, ['none', 'hop', 'subtree', 'receiver', 'leader'])
    ) {
        return undefined;
    }
    return {
        kind: 'receipt-outbox',
        serverPeerId: String(record.serverPeerId),
        receiptControlMsgId: record.receiptControlMsgId,
        receipt,
        verdict,
        deadlineAtMs: record.deadlineAtMs,
        entryCount: record.entryCount,
        trackedReceiptAlgo: record.trackedReceiptAlgo
    };
}

function toSafeAck(record: unknown): ApiJsonObject | undefined {
    if (
        !isApiTimingRecord(record) ||
        !['ackedMsgId', 'originPeerId', 'fromPeerId', 'toPeerId', 'logicalRecipientPeerId'].every((field) =>
            isSafeApiTimingIdentity(record[field])
        ) ||
        !isAllowedApiTimingString(record.carrier, ['ws', 'rtc']) ||
        !isAllowedApiTimingString(record.status, ['accepted', 'delivered', 'forwarded', 'subtree-complete']) ||
        !isNonNegativeApiTimingNumber(record.observedAtEpochMs)
    ) {
        return undefined;
    }
    return {
        ackedMsgId: String(record.ackedMsgId),
        originPeerId: String(record.originPeerId),
        fromPeerId: String(record.fromPeerId),
        toPeerId: String(record.toPeerId),
        logicalRecipientPeerId: String(record.logicalRecipientPeerId),
        carrier: record.carrier,
        status: record.status,
        observedAtEpochMs: record.observedAtEpochMs
    };
}

function toSafeAckIdentity(
    record: Readonly<Record<string, unknown>>,
    kind: SafeApiWsReceiptObservationDto['kind'],
    ack: ApiJsonObject
): SafeApiWsReceiptObservationDto {
    const fields: Record<string, ApiJsonValue> = {};
    retainSafeIdentity(fields, record, 'controlMsgId');
    retainSafeIdentity(fields, record, 'controlSenderId');
    retainSafeNumber(fields, record, 'controlCreatedAtEpochMs');
    return { kind, serverPeerId: String(record.serverPeerId), ack, ...fields };
}

function toSafeAggregate(record: unknown): ApiJsonObject | undefined {
    if (
        !isApiTimingRecord(record) || !isSafeApiTimingIdentity(record.msgId) ||
        !isSafeApiTimingIdentity(record.originPeerId) ||
        !isNonNegativeApiTimingNumber(record.snapshotVersion) || !isNonNegativeApiTimingNumber(record.deadlineAtMs) ||
        !isSafePeerIds(record.expectedRecipientPeerIds) || !isSafePeerIds(record.confirmedRecipientPeerIds)
    ) {
        return undefined;
    }
    return {
        msgId: record.msgId,
        originPeerId: record.originPeerId,
        snapshotVersion: record.snapshotVersion,
        deadlineAtMs: record.deadlineAtMs,
        expectedRecipientPeerIds: [...record.expectedRecipientPeerIds],
        confirmedRecipientPeerIds: [...record.confirmedRecipientPeerIds]
    };
}

function toSafeReceipt(record: unknown): ApiJsonObject | undefined {
    if (
        !isApiTimingRecord(record) || !isSafeApiTimingIdentity(record.msgId) ||
        !isSafeApiTimingIdentity(record.originPeerId) ||
        !isNonNegativeApiTimingNumber(record.snapshotVersion) ||
        !isNonNegativeApiTimingNumber(record.observedAtEpochMs) ||
        !isAllowedApiTimingString(record.phase, ['admitted', 'complete', 'timed-out']) ||
        !isSafePeerIds(record.expectedRecipientPeerIds) || !isSafePeerIds(record.confirmedRecipientPeerIds)
    ) {
        return undefined;
    }
    return {
        msgId: record.msgId,
        originPeerId: record.originPeerId,
        snapshotVersion: record.snapshotVersion,
        observedAtEpochMs: record.observedAtEpochMs,
        phase: record.phase,
        expectedRecipientPeerIds: [...record.expectedRecipientPeerIds],
        confirmedRecipientPeerIds: [...record.confirmedRecipientPeerIds]
    };
}

const OUTBOX_VERDICT_KINDS = [
    'admitted',
    'duplicate',
    'pending',
    'deferred',
    'refused',
    'unroutable',
    'superseded',
    'expired',
    'skipped',
    'storage-unavailable',
    'failed'
];
const OUTBOX_VERDICT_REASONS = [
    'not-yet-in-sync',
    'unauthorized',
    'malformed',
    'oversized',
    'unsupported',
    'capacity',
    'no-leader',
    'congested',
    'no-route',
    'rate-limited',
    'circuit-open',
    'disposed',
    'repair-exhausted',
    'pending-terminated',
    'planner-drop'
];
const OUTBOX_STORAGE_CAUSES = [
    'missing',
    'open-failed',
    'reset-blocked',
    'quota',
    'closed',
    'evicted',
    'transaction-failed',
    'checkpoint-lag'
];

function toSafeOutboxVerdict(record: unknown): ApiJsonObject | undefined {
    if (!isApiTimingRecord(record) || !isAllowedApiTimingString(record.kind, OUTBOX_VERDICT_KINDS)) {
        return undefined;
    }
    const safe: Record<string, ApiJsonValue> = { kind: record.kind };
    if (isAllowedApiTimingString(record.reason, OUTBOX_VERDICT_REASONS)) {
        safe.reason = record.reason;
    }
    switch (record.kind) {
        case 'admitted':
            if (typeof record.durable !== 'boolean' || !isNonNegativeApiTimingNumber(record.queuedAttempts)) {
                return undefined;
            }
            safe.durable = record.durable;
            safe.queuedAttempts = record.queuedAttempts;
            break;
        case 'storage-unavailable':
            if (!isAllowedApiTimingString(record.cause, OUTBOX_STORAGE_CAUSES)) {
                return undefined;
            }
            safe.cause = record.cause;
            break;
        case 'refused':
            if (record.limit === undefined) {
                break;
            }
            if (!isAllowedApiTimingString(record.limit, ['admissions', 'bytes', 'age', 'tracks'])) {
                return undefined;
            }
            safe.limit = record.limit;
            break;
    }
    return safe;
}

function retainSafeIdentity(
    safe: Record<string, ApiJsonValue>,
    record: Readonly<Record<string, unknown>>,
    field: string
): void {
    if (isSafeApiTimingIdentity(record[field])) {
        safe[field] = record[field];
    }
}

function retainSafeNumber(
    safe: Record<string, ApiJsonValue>,
    record: Readonly<Record<string, unknown>>,
    field: string
): void {
    if (isNonNegativeApiTimingNumber(record[field])) {
        safe[field] = record[field];
    }
}

function retainSafeRejection(safe: Record<string, ApiJsonValue>, record: Readonly<Record<string, unknown>>): void {
    if (
        isAllowedApiTimingString(record.rejectionCode, [
            'malformed',
            'unsupported',
            'unauthorized',
            'oversized',
            'capacity'
        ])
    ) {
        safe.rejectionCode = record.rejectionCode;
    }
}

function isSafePeerIds(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every(isSafeApiTimingIdentity);
}

export function isApiTimingRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isSafeApiTimingIdentity(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_.:%|/@-]{1,512}$/.test(value);
}

export function isAllowedApiTimingString(value: unknown, allowed: readonly string[]): value is string {
    return typeof value === 'string' && allowed.includes(value);
}

export function isNonNegativeApiTimingNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
