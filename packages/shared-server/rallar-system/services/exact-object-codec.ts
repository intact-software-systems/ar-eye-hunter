export function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (
        !value || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype
    ) {
        throw new TypeError(`${label} must be an exact object`);
    }
    return value as Record<string, unknown>;
}

export function requireExactKeys(
    value: Record<string, unknown>,
    keys: readonly string[],
    label: string,
): void {
    if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
        throw new TypeError(`${label} fields are invalid`);
    }
}

export function requireExactOptionalKeys(
    value: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[],
    label: string,
): void {
    const keys = Object.keys(value);
    if (
        required.some((key) => !keys.includes(key)) ||
        keys.some((key) => !required.includes(key) && !optional.includes(key))
    ) throw new TypeError(`${label} fields are invalid`);
}

export function requireString(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} must be a non-empty string`);
    }
}

export function requireEpoch(value: unknown, label: string): void {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new TypeError(`${label} must be a non-negative safe integer`);
    }
}

export function requirePositiveInteger(value: unknown, label: string): void {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
        throw new TypeError(`${label} must be a positive safe integer`);
    }
}

export function requireNullableEpoch(value: unknown, label: string): void {
    if (value !== null) requireEpoch(value, label);
}

export function requireNullableInteger(value: unknown, label: string): void {
    if (value !== null) requireEpoch(value, label);
}

export function requireOneOf<T extends string>(
    value: unknown,
    values: readonly T[],
    label: string,
): T {
    if (typeof value !== 'string' || !values.includes(value as T)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value as T;
}
