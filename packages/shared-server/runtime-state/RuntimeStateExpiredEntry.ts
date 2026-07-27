import type { RuntimeStateEntry } from './RuntimeStateRepository.ts';

export function validateRuntimeStateExpiredEntry(
    input: unknown,
    expectedKey: string,
    observedAtEpochMs = Number.MAX_SAFE_INTEGER,
): RuntimeStateEntry {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new TypeError('Expired runtime state entry must be an object');
    }
    const entry = input as Readonly<Record<string, unknown>>;
    const expectedFields = [
        'key', 'value', 'expireAtTimestamp', 'updatedTimestamp', 'revision',
    ];
    if (JSON.stringify(Object.keys(entry).sort()) !==
        JSON.stringify(expectedFields.sort())) {
        throw new TypeError('Expired runtime state entry fields are invalid');
    }
    if (entry.key !== expectedKey || typeof entry.value !== 'string') {
        throw new TypeError('Expired runtime state entry identity is invalid');
    }
    if (!Number.isSafeInteger(entry.expireAtTimestamp) ||
        (entry.expireAtTimestamp as number) < 0 ||
        (entry.expireAtTimestamp as number) > observedAtEpochMs) {
        throw new TypeError('Expired runtime state entry lifecycle is invalid');
    }
    if (!Number.isSafeInteger(entry.revision) || Object.is(entry.revision, -0) ||
        (entry.revision as number) < 0) {
        throw new TypeError('Expired runtime state entry revision is invalid');
    }
    if (typeof entry.updatedTimestamp !== 'string' ||
        entry.updatedTimestamp.length === 0 ||
        Number.isNaN(Date.parse(entry.updatedTimestamp))) {
        throw new TypeError('Expired runtime state entry timestamp is invalid');
    }
    return entry as RuntimeStateEntry;
}

export function validateRuntimeStateExpiredAuthority(
    live: unknown,
    expiredEntry: RuntimeStateEntry | null,
    expectedKey: string,
    label: string,
): void {
    if (!expiredEntry) return;
    if (live) throw new TypeError(`${label} has live and expired authority`);
    validateRuntimeStateExpiredEntry(expiredEntry, expectedKey);
}
