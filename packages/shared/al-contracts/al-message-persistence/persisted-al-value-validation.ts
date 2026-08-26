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

export function decodePersistedALRecord(serialized: string, label: string): PersistedALRecord {
    return requirePersistedALRecord(JSON.parse(serialized), label);
}

export function requirePersistedALFields(
    value: PersistedALRecord,
    allowed: readonly string[],
    required: readonly string[]
): void {
    const keys: string[] = [];
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') {
            throw new TypeError('Persisted AL section has a symbol field');
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
            !descriptor || !descriptor.enumerable ||
            !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        ) {
            throw new TypeError('Persisted AL section fields must be enumerable data properties');
        }
        keys.push(key);
    }
    if (keys.some((key) => !allowed.includes(key))) {
        throw new TypeError('Persisted AL section has unknown fields');
    }
    if (required.some((key) => !keys.includes(key))) {
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
    return value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype;
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
): readonly string[] | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isPersistedALStringArray(value)) {
        throw new TypeError(`Persisted AL ${label} is invalid`);
    }
    return value;
}

export function requireOptionalPersistedALUniqueStringArray(
    value: PersistedALValue | undefined,
    label: string
): void {
    const strings = requireOptionalPersistedALStringArray(value, label);
    if (strings && new Set(strings).size !== strings.length) {
        throw new TypeError(`Persisted AL ${label} contains duplicates`);
    }
}

function isPersistedALStringArray(value: PersistedALValue): value is readonly string[] {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
        return false;
    }
    const entryKeys = Reflect.ownKeys(value).filter((key) => key !== 'length');
    if (entryKeys.length !== value.length) {
        return false;
    }
    return entryKeys.every((key) => {
        if (typeof key !== 'string' || !isCanonicalArrayIndex(key, value.length)) {
            return false;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return Boolean(
            descriptor &&
                descriptor.enumerable &&
                Object.prototype.hasOwnProperty.call(descriptor, 'value') &&
                typeof descriptor.value === 'string' &&
                descriptor.value.length > 0
        );
    });
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
    if (!/^(0|[1-9]\d*)$/.test(key)) {
        return false;
    }
    const index = Number(key);
    return Number.isSafeInteger(index) && index >= 0 && index < length;
}
