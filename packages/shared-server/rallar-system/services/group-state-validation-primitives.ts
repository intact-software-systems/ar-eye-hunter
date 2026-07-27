export function assertExactKeys(
    value: Readonly<Record<string, unknown>>,
    allowed: readonly string[],
    label: string,
): void {
    const allowedSet = new Set(allowed);
    const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
    if (unexpected) throw new TypeError(`${label} has unexpected key: ${unexpected}`);
}

export function assertRequiredKeys(
    value: Readonly<Record<string, unknown>>,
    required: readonly string[],
    label: string,
): void {
    const missing = required.find((key) => !Object.hasOwn(value, key));
    if (missing) throw new TypeError(`${label} is missing mandatory key: ${missing}`);
}

export function requireOneOf(
    value: unknown,
    allowed: readonly string[],
    label: string,
): void {
    if (typeof value !== 'string' || !allowed.includes(value)) {
        throw new TypeError(`${label} is invalid`);
    }
}

export function requireRecord(
    value: unknown,
    label: string,
): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

export function requireNonEmptyString(
    value: unknown,
    label: string,
): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} must be a non-empty string`);
    }
}

export function nullableNonEmptyString(value: unknown, label: string): void {
    if (value !== null) requireNonEmptyString(value, label);
}

export function requireNonNegativeSafeInteger(
    value: unknown,
    label: string,
): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new TypeError(`${label} must be a non-negative safe integer`);
    }
}

export function requirePositiveSafeInteger(
    value: unknown,
    label: string,
): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
        throw new TypeError(`${label} must be a positive safe integer`);
    }
}

export function nullablePositiveSafeInteger(
    value: unknown,
    label: string,
): asserts value is number | null {
    if (value !== null) requirePositiveSafeInteger(value, label);
}

export function requireJsonSafe(value: unknown, label: string): void {
    const seen = new Set<object>();
    const visit = (current: unknown): void => {
        if (current === null || typeof current === 'string' ||
            typeof current === 'boolean') return;
        if (typeof current === 'number') {
            if (!Number.isFinite(current) || Object.is(current, -0)) {
                throw new TypeError(`${label} must contain only JSON-safe numbers`);
            }
            return;
        }
        if (typeof current !== 'object') throw new TypeError(`${label} must be JSON-safe`);
        if (seen.has(current)) throw new TypeError(`${label} must not be cyclic`);
        seen.add(current);
        if (Array.isArray(current)) {
            for (const entry of current) visit(entry);
        } else {
            const prototype = Object.getPrototypeOf(current);
            if (prototype !== Object.prototype && prototype !== null) {
                throw new TypeError(`${label} must use plain objects`);
            }
            for (const [key, entry] of Object.entries(current)) {
                if (entry === undefined) {
                    throw new TypeError(`${label}.${key} must be present`);
                }
                visit(entry);
            }
        }
        seen.delete(current);
    };
    visit(value);
}
