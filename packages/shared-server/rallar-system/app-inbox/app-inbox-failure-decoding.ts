import type {
    AppInboxFailure,
    AppInboxFailureDenial,
    AppInboxFailureIssue,
    AppInboxFailureRetry
} from './app-inbox-failure.ts';
const CANONICAL_V2_FAILURE_KEYS = [
    'type',
    'version',
    'code',
    'status',
    'message',
    'issues',
    'denial',
    'retry'
] as const;

export function readPersistedAppInboxFailure(resource: string): AppInboxFailure {
    try {
        const parsed = JSON.parse(resource) as unknown;
        return readAppInboxFailure(parsed);
    }
    catch {
        return malformedPersistedAppInboxFailure();
    }
}

export function readAppInboxFailure(value: unknown): AppInboxFailure {
    const record = requireExactRecord(
        value,
        CANONICAL_V2_FAILURE_KEYS,
        'AppInbox failure'
    );
    if (record.type !== 'app-inbox-failure') {
        throw new TypeError('AppInbox failure type is invalid');
    }
    if (record.version !== 'canonical.v2' && record.version !== 'retry-exhausted.v1') {
        throw new TypeError('AppInbox failure version is invalid');
    }
    const code = requireNonEmptyString(record.code, 'AppInbox failure code');
    const status = requireHttpFailureStatus(record.status);
    const message = requireNonEmptyString(record.message, 'AppInbox failure message');
    const issues = readIssues(record.issues);
    const denial = readDenial(record.denial);
    const retry = readRetry(record.retry);
    if (
        record.version === 'retry-exhausted.v1' &&
        (code !== 'app-inbox-retry-exhausted' || status !== 503 || retry?.kind !== 'exhausted')
    ) {
        throw new TypeError('AppInbox retry exhaustion fields are inconsistent');
    }
    return {
        type: 'app-inbox-failure',
        version: record.version,
        code,
        status,
        message,
        issues,
        denial,
        retry
    };
}

function malformedPersistedAppInboxFailure(): AppInboxFailure {
    return {
        type: 'app-inbox-failure',
        version: 'malformed.v0',
        code: 'app-inbox-malformed-persisted-failure',
        status: 500,
        message: 'Persisted AppInbox failure is malformed',
        issues: null,
        denial: null,
        retry: null
    };
}

function readIssues(value: unknown): readonly AppInboxFailureIssue[] | null {
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
            path: readPath(record.path),
            message: requireNonEmptyString(record.message, 'AppInbox failure issue message'),
            details: readNullableRecord(record.details, 'AppInbox failure issue details')
        };
    });
}

function readDenial(value: unknown): AppInboxFailureDenial | null {
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
        details: readNullableRecord(record.details, 'AppInbox failure denial details')
    };
}

function readRetry(value: unknown): AppInboxFailureRetry | null {
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
        attempts: readNullableNonNegativeInteger(record.attempts, 'attempts'),
        lane: record.lane === null
            ? null
            : requireNonEmptyString(record.lane, 'AppInbox failure retry lane'),
        queueAgeMs: readNullableNonNegativeNumber(record.queueAgeMs, 'queueAgeMs'),
        dueAgeMs: readNullableNonNegativeNumber(record.dueAgeMs, 'dueAgeMs')
    };
}

function readPath(value: unknown): readonly (string | number)[] | null {
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

function readNullableRecord(
    value: unknown,
    label: string
): Readonly<Record<string, unknown>> | null {
    if (value === null) {
        return null;
    }
    if (!isRecord(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}

function readNullableNonNegativeInteger(value: unknown, label: string): number | null {
    if (value === null) {
        return null;
    }
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new TypeError(`AppInbox failure retry ${label} is invalid`);
    }
    return Number(value);
}

function readNullableNonNegativeNumber(value: unknown, label: string): number | null {
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
