import type { JsonWireObject, JsonWireValue } from './json-wire-identity.ts';

/** Narrow a JSON-wire value to an object, for boundary decoders. */
export function toJsonWireObject(value: JsonWireValue | undefined, label: string): JsonWireObject {
    if (
        value === undefined ||
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value)
    ) {
        throw new TypeError(`${label} must be an object`);
    }
    return value as JsonWireObject;
}

/** Narrow to an object and reject any key outside the exact allowlist. */
export function toExactJsonWireObject(
    value: JsonWireValue | undefined,
    keys: readonly string[],
    label: string
): JsonWireObject {
    const record = toJsonWireObject(value, label);
    const allowed = new Set(keys);
    for (const key of Object.keys(record)) {
        if (!allowed.has(key)) {
            throw new TypeError(`${label} has unexpected key: ${key}`);
        }
    }
    for (const key of keys) {
        if (!(key in record)) {
            throw new TypeError(`${label} is missing mandatory key: ${key}`);
        }
    }
    return record;
}
