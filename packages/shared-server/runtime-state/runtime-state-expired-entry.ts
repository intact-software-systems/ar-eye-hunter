import type { RuntimeStateEntry } from './runtime-state-repository.ts';

export function validateRuntimeStateExpiredEntry(
    input: unknown,
    expectedKey: string,
    observedAtEpochMs = Number.MAX_SAFE_INTEGER
): RuntimeStateEntry {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new TypeError('Expired runtime state entry must be an object');
    }
    const entry = input as Readonly<Record<string, unknown>>;
    const expectedFields = [
        'key',
        'value',
        'expireAtTimestamp',
        'updatedTimestamp',
        'revision'
    ];
    if (
        JSON.stringify(Object.keys(entry).sort()) !==
            JSON.stringify(expectedFields.sort())
    ) {
        throw new TypeError('Expired runtime state entry fields are invalid');
    }
    const key = entry.key;
    const value = entry.value;
    if (key !== expectedKey || typeof value !== 'string') {
        throw new TypeError('Expired runtime state entry identity is invalid');
    }
    const expireAtTimestamp = entry.expireAtTimestamp;
    if (
        typeof expireAtTimestamp !== 'number' ||
        !Number.isSafeInteger(expireAtTimestamp) ||
        expireAtTimestamp < 0 ||
        expireAtTimestamp > observedAtEpochMs
    ) {
        throw new TypeError('Expired runtime state entry lifecycle is invalid');
    }
    const revision = entry.revision;
    if (
        typeof revision !== 'number' ||
        !Number.isSafeInteger(revision) ||
        Object.is(revision, -0) ||
        revision < 0
    ) {
        throw new TypeError('Expired runtime state entry revision is invalid');
    }
    const updatedTimestamp = entry.updatedTimestamp;
    if (
        typeof updatedTimestamp !== 'string' ||
        updatedTimestamp.length === 0 ||
        Number.isNaN(Date.parse(updatedTimestamp))
    ) {
        throw new TypeError('Expired runtime state entry timestamp is invalid');
    }
    return { key, value, expireAtTimestamp, updatedTimestamp, revision };
}

export interface RuntimeStateExpiredAuthorityInput {
    readonly live: object | null | undefined;
    readonly expiredEntry: RuntimeStateEntry | null;
    readonly expectedKey: string;
    readonly label: string;
}

export function validateRuntimeStateExpiredAuthority(
    input: RuntimeStateExpiredAuthorityInput
): void {
    const { live, expiredEntry, expectedKey, label } = input;
    if (!expiredEntry) {
        return;
    }
    if (live) {
        throw new TypeError(`${label} has live and expired authority`);
    }
    validateRuntimeStateExpiredEntry(expiredEntry, expectedKey);
}
