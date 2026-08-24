import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '../protocol/json-wire-identity.ts';
import {
    toPersistedAppInboxFailureCorruption,
    type AppInboxFailure,
    type AppInboxFailureDenial,
    type AppInboxFailureIssue,
    type AppInboxFailureRetry
} from './app-inbox-failure.ts';

const APP_INBOX_FAILURE_KEYS = [
    'type',
    'code',
    'status',
    'message',
    'issues',
    'denial',
    'retry'
] as const;

export function decodePersistedAppInboxFailure(resource: string): AppInboxFailure {
    try {
        return decodeAppInboxFailure(JSON.parse(resource));
    }
    catch {
        return toPersistedAppInboxFailureCorruption();
    }
}

export function decodeAppInboxFailure(value: unknown): AppInboxFailure {
    const record = requireExactRecord(value, APP_INBOX_FAILURE_KEYS, 'AppInbox failure');
    if (record.type !== 'app-inbox-failure') {
        throw new TypeError('AppInbox failure type is invalid');
    }
    return {
        type: 'app-inbox-failure',
        code: requireNonEmptyString(record.code, 'AppInbox failure code'),
        status: requireHttpFailureStatus(record.status),
        message: requireNonEmptyString(record.message, 'AppInbox failure message'),
        issues: decodeFailureIssues(record.issues),
        denial: decodeFailureDenial(record.denial),
        retry: decodeFailureRetry(record.retry)
    };
}

function decodeFailureIssues(value: unknown): readonly AppInboxFailureIssue[] | null {
    if (value === null) {
        return null;
    }
    if (!Array.isArray(value)) {
        throw new TypeError('AppInbox failure issues are invalid');
    }
    return value.map((issue, index) => {
        const record = requireExactRecord(
            issue,
            ['code', 'path', 'message', 'details'],
            `AppInbox failure issue ${index}`
        );
        return {
            code: requireNonEmptyString(record.code, 'AppInbox failure issue code'),
            path: decodeFailureIssuePath(record.path),
            message: requireNonEmptyString(record.message, 'AppInbox failure issue message'),
            details: decodeNullableJsonWireObject(record.details, 'AppInbox failure issue details')
        };
    });
}

function decodeFailureDenial(value: unknown): AppInboxFailureDenial | null {
    if (value === null) {
        return null;
    }
    const record = requireExactRecord(
        value,
        ['code', 'message', 'details'],
        'AppInbox failure denial'
    );
    return {
        code: requireNonEmptyString(record.code, 'AppInbox failure denial code'),
        message: requireNonEmptyString(record.message, 'AppInbox failure denial message'),
        details: decodeNullableJsonWireObject(record.details, 'AppInbox failure denial details')
    };
}

function decodeFailureRetry(value: unknown): AppInboxFailureRetry | null {
    if (value === null) {
        return null;
    }
    const record = requireExactRecord(
        value,
        ['kind', 'attempts', 'lane', 'queueAgeMs', 'dueAgeMs'],
        'AppInbox failure retry'
    );
    if (record.kind !== 'unavailable' && record.kind !== 'exhausted') {
        throw new TypeError('AppInbox failure retry kind is invalid');
    }
    return {
        kind: record.kind,
        attempts: decodeNullableNonNegativeInteger(record.attempts, 'attempts'),
        lane: record.lane === null
            ? null
            : requireNonEmptyString(record.lane, 'AppInbox failure retry lane'),
        queueAgeMs: decodeNullableNonNegativeNumber(record.queueAgeMs, 'queueAgeMs'),
        dueAgeMs: decodeNullableNonNegativeNumber(record.dueAgeMs, 'dueAgeMs')
    };
}

function decodeFailureIssuePath(value: unknown): readonly (string | number)[] | null {
    if (value === null) {
        return null;
    }
    if (
        !Array.isArray(value) ||
        !value.every((part) => typeof part === 'string' || typeof part === 'number')
    ) {
        throw new TypeError('AppInbox failure issue path is invalid');
    }
    return value;
}

function decodeNullableJsonWireObject(
    value: unknown,
    label: string
): JsonWireObject | null {
    if (value === null) {
        return null;
    }
    const decoded = decodeJsonWireValue(value, label);
    if (!isJsonWireObject(decoded)) {
        throw new TypeError(`${label} must be a JSON object`);
    }
    return decoded;
}

function decodeNullableNonNegativeInteger(value: unknown, label: string): number | null {
    if (value === null) {
        return null;
    }
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new TypeError(`AppInbox failure retry ${label} is invalid`);
    }
    return Number(value);
}

function decodeNullableNonNegativeNumber(value: unknown, label: string): number | null {
    if (value === null) {
        return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new TypeError(`AppInbox failure retry ${label} is invalid`);
    }
    return value;
}

function requireHttpFailureStatus(value: unknown): number {
    if (!Number.isInteger(value) || Number(value) < 400 || Number(value) > 599) {
        throw new TypeError('AppInbox failure status is invalid');
    }
    return Number(value);
}

function requireNonEmptyString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}

function requireExactRecord(
    value: unknown,
    expectedKeys: readonly string[],
    label: string
): Record<string, unknown> {
    if (!isRecord(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    const actual = Object.keys(value).toSorted();
    const expected = [...expectedKeys].toSorted();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new TypeError(`${label} fields are invalid`);
    }
    return value;
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
