export type PersistedALValue =
    | null
    | boolean
    | number
    | string
    | readonly PersistedALValue[]
    | PersistedALRecord;

export interface PersistedALRecord {
    readonly [key: string]: PersistedALValue;
}

export function requirePersistedALFields(
    value: PersistedALRecord,
    allowed: readonly string[],
    required: readonly string[]
): void {
    if (Object.keys(value).some((key) => !allowed.includes(key))) {
        throw new TypeError('Persisted AL section has unknown fields');
    }
    if (required.some((key) => !Object.hasOwn(value, key))) {
        throw new TypeError('Persisted AL section is missing mandatory fields');
    }
}

export function requirePersistedALRecord(
    value: PersistedALValue,
    label: string
): PersistedALRecord {
    if (!isPersistedALRecord(value)) {
        throw new TypeError(`Persisted AL ${label} is invalid`);
    }
    return value;
}

function isPersistedALRecord(value: PersistedALValue): value is PersistedALRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function requirePersistedALNonEmptyString(
    value: PersistedALValue | undefined,
    label: string
): void {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`Persisted AL ${label} is invalid`);
    }
}

export function requireOptionalPersistedALNonEmptyString(
    value: PersistedALValue | undefined,
    label: string
): void {
    if (value !== undefined) {
        requirePersistedALNonEmptyString(value, label);
    }
}

export function requirePersistedALSafeInteger(
    value: PersistedALValue | undefined,
    minimum: number,
    label: string
): void {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
        throw new TypeError(`Persisted AL ${label} is invalid`);
    }
}

export function requireOptionalPersistedALSafeInteger(
    value: PersistedALValue | undefined,
    minimum: number,
    label: string
): void {
    if (value !== undefined) {
        requirePersistedALSafeInteger(value, minimum, label);
    }
}

export function requireOptionalPersistedALStringArray(
    value: PersistedALValue | undefined,
    label: string
): void {
    if (value === undefined) {
        return;
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
        throw new TypeError(`Persisted AL ${label} is invalid`);
    }
}

export function requireOptionalPersistedALUniqueStringArray(
    value: PersistedALValue | undefined,
    label: string
): void {
    requireOptionalPersistedALStringArray(value, label);
    if (Array.isArray(value) && new Set(value).size !== value.length) {
        throw new TypeError(`Persisted AL ${label} contains duplicates`);
    }
}
