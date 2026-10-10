import type { ApiJsonValue } from '../../../packages/shared/api/api-json-value.ts';
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
const COMPONENTS = ['http', 'app-inbox', 'app-inbox-phase', 'app-inbox-handler', 'group-state-service', 'ws-receipt'];

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
        safe.details = toSafeTimingDetails(record.details);
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
    if (
        isAllowedApiTimingString(details.queueObservation, [
            'missing',
            'NEW',
            'RESERVED',
            'RETRY',
            'COMPLETED',
            'FAILED',
            'NON_RETRYABLE',
            'other-status',
            'read-failure'
        ])
    ) {
        safe.queueObservation = details.queueObservation;
    }
    if (isAllowedApiTimingString(details.selectedLane, ['NEW', 'RETRY', 'FAIRNESS', 'TIMEOUT', 'FINALIZATION'])) {
        safe.selectedLane = details.selectedLane;
    }
    if (
        isAllowedApiTimingString(details.resultStatus, [
            'NEW',
            'RETRY',
            'RESERVED',
            'COMPLETED',
            'FAILED',
            'ABORTED',
            'NON_RETRYABLE'
        ])
    ) {
        safe.resultStatus = details.resultStatus;
    }
    if (isAllowedApiTimingString(details.classification, ['accepted', 'not-ready', 'retryable', 'non-retryable'])) {
        safe.classification = details.classification;
    }
    if (typeof details.exhaustion === 'boolean') {
        safe.exhaustion = details.exhaustion;
    }
    return safe;
}
