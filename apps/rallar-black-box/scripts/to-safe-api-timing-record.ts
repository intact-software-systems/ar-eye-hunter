import type { ApiJsonValue } from '../../../packages/shared/api/api-json-value.ts';
import {
    GROUP_LAYOUT_IDENTITY_STATES,
    isGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '../../../packages/shared/api/group-lifecycle/group-layout-identity.ts';
import {
    API_TIMING_DEQUEUE_LANES,
    decodeSafeApiDequeuePassDetails
} from './decode-safe-api-dequeue-pass-details.ts';
import { decodeSafeApiTransactionDetails } from './decode-safe-api-transaction-details.ts';
import {
    isAllowedApiTimingString,
    isApiTimingRecord,
    isNonNegativeApiTimingNumber,
    isSafeApiTimingIdentity,
    toSafeApiWsReceiptObservation
} from './to-safe-api-ws-receipt-observation.ts';

interface SafeApiTimingRecordDto {
    readonly type: 'rallar.timing';
    readonly component: string;
    readonly operation: string;
    readonly status: 'ok' | 'error';
    readonly durationMs: number;
    readonly atEpochMs: number;
    [field: string]: ApiJsonValue;
}

const IDENTITY_FIELDS = [
    'serviceId',
    'requestId',
    'applicationId',
    'workspaceId',
    'groupId',
    'principalId',
    'sessionId'
];
const DETAIL_IDENTITIES = ['clientId', 'type', 'topicId', 'contextId', 'resourceId', 'senderId'];
const DETAIL_NUMBERS = [
    'attempt',
    'attempts',
    'processingAttempts',
    'reservationAttempt',
    'queueAgeMs',
    'dueAgeMs',
    'nextAttempt',
    'delayMsecs',
    'elapsedMsecs',
    'waitMaxElapsedMsecs'
];
/** Each detail kept only as one of its closed values. */
const DETAIL_CLOSED_STRINGS: Readonly<Record<string, readonly string[]>> = {
    queueObservation: [
        'missing',
        'NEW',
        'RESERVED',
        'RETRY',
        'COMPLETED',
        'FAILED',
        'NON_RETRYABLE',
        'other-status',
        'read-failure'
    ],
    selectedLane: API_TIMING_DEQUEUE_LANES,
    resultStatus: ['NEW', 'RETRY', 'RESERVED', 'COMPLETED', 'FAILED', 'ABORTED', 'NON_RETRYABLE'],
    classification: ['accepted', 'not-ready', 'retryable', 'non-retryable'],
    trigger: ['first', 'completion', 'tick', 'delay', 'closed'],
    readRow: ['result', 'status']
};
const COMPONENTS = [
    'http',
    'app-inbox',
    'app-inbox-phase',
    'app-inbox-handler',
    'group-state-service',
    'ws-receipt',
    'group-topology-publication'
];
const PROMOTION_OUTCOMES = [
    'promoted',
    'promoted-newer',
    'already-applied',
    'replay',
    'idempotency-conflict',
    'rejected'
];

export function toSafeApiTimingRecord(
    line: string
): SafeApiTimingRecordDto | undefined {
    let record: unknown;
    try {
        record = JSON.parse(line);
    }
    catch {
        return undefined;
    }
    if (
        !isApiTimingRecord(record) || record.type !== 'rallar.timing' ||
        !isAllowedApiTimingString(record.component, COMPONENTS) ||
        !isSafeApiTimingIdentity(record.operation) || (record.status !== 'ok' && record.status !== 'error') ||
        !isNonNegativeApiTimingNumber(record.durationMs) || !isNonNegativeApiTimingNumber(record.atEpochMs)
    ) {
        return undefined;
    }
    if (record.component === 'group-topology-publication') {
        return toSafeTopologyPromotionRecord(record);
    }
    const wsReceipt = record.component === 'ws-receipt' ? toSafeApiWsReceiptObservation(record.wsReceipt) : undefined;
    if (record.component === 'ws-receipt' && (wsReceipt === undefined || record.operation !== wsReceipt.kind)) {
        return undefined;
    }
    const safe: SafeApiTimingRecordDto = {
        type: 'rallar.timing',
        component: record.component,
        operation: record.operation,
        status: record.status,
        durationMs: record.durationMs,
        atEpochMs: record.atEpochMs,
        ...toSafeTimingContext(record)
    };
    if (wsReceipt !== undefined) {
        safe.wsReceipt = wsReceipt;
        if (isApiTimingRecord(record.details) && isSafeApiTimingIdentity(record.details.publisherId)) {
            safe.details = { ...toSafeTimingDetails(record.details), publisherId: record.details.publisherId };
        }
    }
    return safe;
}

function toSafeTopologyPromotionRecord(record: Readonly<Record<string, unknown>>): SafeApiTimingRecordDto | undefined {
    if (
        record.operation !== 'promote' || record.status !== 'ok' ||
        !isSafeApiTimingIdentity(record.applicationId) ||
        !isSafeApiTimingIdentity(record.workspaceId) ||
        !isSafeApiTimingIdentity(record.groupId) ||
        !isApiTimingRecord(record.details) ||
        !isAllowedApiTimingString(record.details.outcome, PROMOTION_OUTCOMES) ||
        !isValidLayoutIdentityLabel(record.details.expected) ||
        !isValidLayoutIdentityLabel(record.details.planned) ||
        ((record.details.outcome === 'promoted' || record.details.outcome === 'promoted-newer') &&
            record.details.planned === 'none')
    ) {
        return undefined;
    }

    return {
        type: 'rallar.timing',
        component: 'group-topology-publication',
        operation: 'promote',
        status: 'ok',
        durationMs: record.durationMs as number,
        atEpochMs: record.atEpochMs as number,
        ...(isSafeApiTimingIdentity(record.serviceId) ? { serviceId: record.serviceId } : {}),
        applicationId: record.applicationId,
        workspaceId: record.workspaceId,
        groupId: record.groupId,
        details: {
            expected: record.details.expected,
            planned: record.details.planned,
            outcome: record.details.outcome
        }
    };
}

function isValidLayoutIdentityLabel(value: unknown): value is string {
    if (value === 'none') {
        return true;
    }
    if (typeof value !== 'string') {
        return false;
    }
    const match = /^group=(0|[1-9]\d*);presence=(0|[1-9]\d*);version=(0|[1-9]\d*);state=([a-z]+)$/.exec(value);
    const state = GROUP_LAYOUT_IDENTITY_STATES.find((candidate) => candidate === match?.[4]);
    if (match === null || state === undefined) {
        return false;
    }
    const identity: GroupLayoutIdentity = {
        groupRevision: Number(match[1]),
        presenceRevision: Number(match[2]),
        version: Number(match[3]),
        state
    };
    return isGroupLayoutIdentity(identity);
}

function toSafeTimingContext(record: Readonly<Record<string, unknown>>): Readonly<Record<string, ApiJsonValue>> {
    const safe: Record<string, ApiJsonValue> = {};
    for (const field of IDENTITY_FIELDS) {
        if (isSafeApiTimingIdentity(record[field])) {
            safe[field] = record[field];
        }
    }
    if (isAllowedApiTimingString(record.method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'])) {
        safe.method = record.method;
    }
    if (typeof record.path === 'string' && /^\/api\/[A-Za-z0-9_./%:-]{1,512}$/.test(record.path)) {
        safe.path = record.path;
    }
    if (
        isNonNegativeApiTimingNumber(record.httpStatus) && Number.isInteger(record.httpStatus) &&
        record.httpStatus <= 599
    ) {
        safe.httpStatus = record.httpStatus;
    }
    if (isApiTimingRecord(record.details)) {
        safe.details = record.component === 'app-inbox-phase' && typeof record.operation === 'string'
            ? {
                ...toSafeTimingDetails(record.details),
                ...decodeSafeApiDequeuePassDetails(record.operation, record.details),
                ...decodeSafeApiTransactionDetails(record.operation, record.details)
            }
            : toSafeTimingDetails(record.details);
    }
    return safe;
}

function toSafeTimingDetails(
    details: Readonly<Record<string, unknown>>
): Readonly<Record<string, string | number | boolean>> {
    const safe: Record<string, string | number | boolean> = {};
    for (const field of DETAIL_IDENTITIES) {
        if (isSafeApiTimingIdentity(details[field])) {
            safe[field] = details[field];
        }
    }
    for (const field of DETAIL_NUMBERS) {
        if (isNonNegativeApiTimingNumber(details[field])) {
            safe[field] = details[field];
        }
    }
    for (const [field, allowed] of Object.entries(DETAIL_CLOSED_STRINGS)) {
        if (isAllowedApiTimingString(details[field], allowed)) {
            safe[field] = details[field];
        }
    }
    if (typeof details.exhaustion === 'boolean') {
        safe.exhaustion = details.exhaustion;
    }
    return safe;
}
