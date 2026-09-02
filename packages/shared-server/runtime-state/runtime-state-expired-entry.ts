import { isValidRuntimeStateExpectedRevision, type RuntimeStateEntry } from './runtime-state-repository.ts';

export interface RuntimeStateExpiredValidationIssue {
    readonly path: string;
    readonly cause: TypeError;
}

const EXPIRED_ENTRY_FIELDS: readonly string[] = ['key', 'value', 'expireAtTimestamp', 'updatedTimestamp', 'revision'];

export function validateRuntimeStateExpiredEntryIssues(
    input: unknown,
    expectedKey: string,
    observedAtEpochMs = Number.MAX_SAFE_INTEGER
): readonly RuntimeStateExpiredValidationIssue[] {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return [{ path: 'entry', cause: new TypeError('Expired runtime state entry must be an object') }];
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const issues: RuntimeStateExpiredValidationIssue[] = [];
    const fields = Object.keys(input);
    if (
        fields.length !== EXPIRED_ENTRY_FIELDS.length || fields.some((field) => !EXPIRED_ENTRY_FIELDS.includes(field))
    ) {
        issues.push({ path: 'entry', cause: new TypeError('Expired runtime state entry fields are invalid') });
    }
    if (descriptors.key?.value !== expectedKey) {
        issues.push({ path: 'entry.key', cause: new TypeError('Expired runtime state entry identity is invalid') });
    }
    if (typeof descriptors.value?.value !== 'string') {
        issues.push({ path: 'entry.value', cause: new TypeError('Expired runtime state entry identity is invalid') });
    }
    const expireAtTimestamp: unknown = descriptors.expireAtTimestamp?.value;
    if (
        typeof expireAtTimestamp !== 'number' ||
        !Number.isSafeInteger(expireAtTimestamp) ||
        expireAtTimestamp < 0 ||
        expireAtTimestamp > observedAtEpochMs
    ) {
        issues.push({
            path: 'entry.expireAtTimestamp',
            cause: new TypeError('Expired runtime state entry lifecycle is invalid')
        });
    }
    if (!isValidRuntimeStateExpectedRevision(descriptors.revision?.value)) {
        issues.push({
            path: 'entry.revision',
            cause: new TypeError('Expired runtime state entry revision is invalid')
        });
    }
    const updatedTimestamp: unknown = descriptors.updatedTimestamp?.value;
    if (
        typeof updatedTimestamp !== 'string' ||
        updatedTimestamp.length === 0 ||
        Number.isNaN(Date.parse(updatedTimestamp))
    ) {
        issues.push({
            path: 'entry.updatedTimestamp',
            cause: new TypeError('Expired runtime state entry timestamp is invalid')
        });
    }
    return issues;
}

export interface RuntimeStateExpiredAuthorityInput {
    readonly live: object | null | undefined;
    readonly expiredEntry: RuntimeStateEntry | null;
    readonly expectedKey: string;
    readonly label: string;
}

export function validateRuntimeStateExpiredAuthorityIssues(
    input: RuntimeStateExpiredAuthorityInput
): readonly RuntimeStateExpiredValidationIssue[] {
    const { live, expiredEntry, expectedKey, label } = input;
    if (!expiredEntry) {
        return [];
    }
    const issues: RuntimeStateExpiredValidationIssue[] = [];
    if (live) {
        issues.push({ path: 'expiredEntry', cause: new TypeError(`${label} has live and expired authority`) });
    }
    return [...issues, ...validateRuntimeStateExpiredEntryIssues(expiredEntry, expectedKey)];
}

export function validateRuntimeStateExpiredAuthority(
    input: RuntimeStateExpiredAuthorityInput
): void {
    const issues = validateRuntimeStateExpiredAuthorityIssues(input);
    if (issues.length > 0) {
        throw issues[0].cause;
    }
}
