import type {
    AppInboxFailure,
    LegacyAppInboxRetryExhaustionWire,
} from './app-inbox-failure.ts';

const BASE_OBJECT_KEYS = ['error', 'code', 'message', 'status'] as const;
const BASE_OBJECT_WITH_DETAILS_KEYS = [...BASE_OBJECT_KEYS, 'details'] as const;
const POLICY_DENIAL_KEYS = ['error', 'code', 'message'] as const;
const POLICY_DENIAL_WITH_DETAILS_KEYS = [...POLICY_DENIAL_KEYS, 'details'] as const;

export function readLegacyPersistedAppInboxFailure(
    value: unknown,
): AppInboxFailure | null {
    if (typeof value === 'string') {
        return {
            type: 'app-inbox-failure',
            version: 'legacy-string.v0',
            code: 'app-inbox-legacy-string',
            status: 500,
            message: value,
            issues: null,
            denial: null,
            retry: null,
        };
    }
    if (!isRecord(value)) {
        return null;
    }
    if (value.type === 'app-inbox-retry-exhausted') {
        return readLegacyRetryExhaustion(value);
    }
    if (hasExactKeys(value, BASE_OBJECT_KEYS)) {
        return readLegacyBaseObject(value, false);
    }
    if (hasExactKeys(value, BASE_OBJECT_WITH_DETAILS_KEYS)) {
        return readLegacyBaseObject(value, true);
    }
    if (hasExactKeys(value, POLICY_DENIAL_KEYS)) {
        return readLegacyPolicyDenial(value, false);
    }
    if (hasExactKeys(value, POLICY_DENIAL_WITH_DETAILS_KEYS)) {
        return readLegacyPolicyDenial(value, true);
    }
    return null;
}

function readLegacyBaseObject(
    record: Record<string, unknown>,
    hasDetails: boolean,
): AppInboxFailure {
    requireNonEmptyString(record.error, 'legacy AppInbox error');
    const code = requireNonEmptyString(record.code, 'legacy AppInbox code');
    const message = requireNonEmptyString(record.message, 'legacy AppInbox message');
    const status = requireHttpFailureStatus(record.status);
    const details = hasDetails
        ? requireRecord(record.details, 'legacy AppInbox details')
        : null;
    return {
        type: 'app-inbox-failure',
        version: 'legacy-object.v0',
        code,
        status,
        message,
        issues: null,
        denial: status === 403 ? { code, message, details } : null,
        retry: null,
    };
}

function readLegacyPolicyDenial(
    record: Record<string, unknown>,
    hasDetails: boolean,
): AppInboxFailure {
    const error = requireNonEmptyString(record.error, 'legacy AppInbox denial error');
    if (!error.startsWith('Forbidden:')) {
        throw new TypeError('Legacy AppInbox denial error is invalid');
    }
    const code = requireNonEmptyString(record.code, 'legacy AppInbox denial code');
    const message = requireNonEmptyString(record.message, 'legacy AppInbox denial message');
    const details = hasDetails
        ? requireRecord(record.details, 'legacy AppInbox denial details')
        : null;
    return {
        type: 'app-inbox-failure',
        version: 'legacy-policy-denial.v0',
        code,
        status: 403,
        message,
        issues: null,
        denial: { code, message, details },
        retry: null,
    };
}

function readLegacyRetryExhaustion(
    value: Record<string, unknown>,
): AppInboxFailure | null {
    if (Object.hasOwn(value, 'status')) {
        return null;
    }
    validateLegacyRetryExhaustionWire(value);
    return {
        type: 'app-inbox-failure',
        version: 'legacy-retry-exhausted.v0',
        code: 'app-inbox-retry-exhausted',
        status: 503,
        message: 'AppInbox processing exhausted its retry budget',
        issues: null,
        denial: null,
        retry: {
            kind: 'exhausted',
            attempts: value.processingAttempts,
            lane: value.selectedLane,
            queueAgeMs: value.queueAgeMs,
            dueAgeMs: value.dueAgeMs,
        },
        legacyWire: value,
    };
}

function validateLegacyRetryExhaustionWire(
    value: unknown,
): asserts value is LegacyAppInboxRetryExhaustionWire {
    if (!isRecord(value)) {
        throw new TypeError('Legacy AppInbox retry exhaustion is invalid');
    }
    const timingKeys = Object.hasOwn(value, 'exhaustedAtEpochMs')
        ? ['exhaustedAtEpochMs']
        : ['selectedDueAtEpochMs', 'finalizedAtEpochMs'];
    const record = requireExactRecord(value, [
        'type',
        'commandIdentity',
        'selectedLane',
        'processingAttempts',
        'reservationAttempt',
        'lastError',
        'queueAgeMs',
        'dueAgeMs',
        ...timingKeys,
    ], 'legacy AppInbox retry exhaustion');
    if (record.type !== 'app-inbox-retry-exhausted') {
        throw new TypeError('Legacy AppInbox retry exhaustion type is invalid');
    }
    readRetryExhaustionIdentity(record.commandIdentity);
    readRetryExhaustionError(record.lastError);
    requireNonEmptyString(record.selectedLane, 'legacy AppInbox retry lane');
    const attempts = requirePositiveInteger(
        record.processingAttempts,
        'legacy AppInbox processing attempts',
    );
    const reservationAttempt = requirePositiveInteger(
        record.reservationAttempt,
        'legacy AppInbox reservation attempt',
    );
    if (reservationAttempt < attempts) {
        throw new TypeError('Legacy AppInbox reservation attempt is invalid');
    }
    requireNonNegativeNumber(record.queueAgeMs, 'legacy queue age');
    requireNonNegativeNumber(record.dueAgeMs, 'legacy due age');
    for (const key of timingKeys) {
        requireNonNegativeNumber(record[key], `legacy timing ${key}`);
    }
}

function readRetryExhaustionIdentity(value: unknown): void {
    const record = requireExactRecord(
        value,
        ['contextId', 'resourceId', 'topicId', 'operation', 'operationSource'],
        'legacy AppInbox retry identity',
    );
    for (const key of ['contextId', 'resourceId', 'topicId', 'operation'] as const) {
        requireNonEmptyString(record[key], `legacy AppInbox identity ${key}`);
    }
    if (!['command', 'corrupt', 'unavailable'].includes(String(record.operationSource))) {
        throw new TypeError('Legacy AppInbox operation source is invalid');
    }
}

function readRetryExhaustionError(value: unknown): void {
    const record = requireExactRecord(
        value,
        ['source', 'code', 'message'],
        'legacy AppInbox retry error',
    );
    if (!['processing', 'finalization-recovery'].includes(String(record.source))) {
        throw new TypeError('Legacy AppInbox retry error source is invalid');
    }
    requireNonEmptyString(record.code, 'legacy AppInbox retry error code');
    requireNonEmptyString(record.message, 'legacy AppInbox retry error message');
}

function requireExactRecord(
    value: unknown,
    expectedKeys: readonly string[],
    label: string,
): Record<string, unknown> {
    if (!isRecord(value) || !hasExactKeys(value, expectedKeys)) {
        throw new TypeError(`${label} fields are invalid`);
    }
    return value;
}

function hasExactKeys(
    value: Record<string, unknown>,
    expectedKeys: readonly string[],
): boolean {
    return JSON.stringify(Object.keys(value).toSorted()) ===
        JSON.stringify([...expectedKeys].toSorted());
}

function requireNonEmptyString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}

function requireHttpFailureStatus(value: unknown): number {
    if (!Number.isSafeInteger(value) || Number(value) < 400 || Number(value) > 599) {
        throw new TypeError('Legacy AppInbox status is invalid');
    }
    return Number(value);
}

function requirePositiveInteger(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || Number(value) < 1) {
        throw new TypeError(`${label} is invalid`);
    }
    return Number(value);
}

function requireNonNegativeNumber(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}

function requireRecord(
    value: unknown,
    label: string,
): Readonly<Record<string, unknown>> {
    if (!isRecord(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
