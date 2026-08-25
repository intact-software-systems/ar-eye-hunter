import type { JsonWireObject, JsonWireValue } from '../../protocol/json-wire-identity.ts';

export function decodeAuthPersistenceObject(
    input: JsonWireValue,
    label: string
): JsonWireObject {
    if (
        typeof input !== 'object' ||
        input === null ||
        Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Object.prototype
    ) {
        throw new TypeError(`${label} must be a plain JSON object`);
    }
    return input as JsonWireObject;
}

export function assertExactAuthPersistenceKeys(
    value: JsonWireObject,
    expectedKeys: readonly string[],
    label: string
): void {
    const actual = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new TypeError(`${label} fields are invalid`);
    }
}

export function decodeAuthPersistenceString(
    value: JsonWireValue | undefined,
    label: string
): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} is required`);
    }
    return value;
}

export function decodeAuthPersistenceTimestamp(
    value: JsonWireValue | undefined,
    label: string
): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}

export function decodePositiveAuthPersistenceInteger(
    value: JsonWireValue | undefined,
    label: string
): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}

export function decodeAuthPersistenceStringList(
    value: JsonWireValue | undefined,
    label: string
): readonly string[] {
    if (
        !Array.isArray(value) ||
        value.some((entry) => typeof entry !== 'string' || entry.length === 0)
    ) {
        throw new TypeError(`${label} is invalid`);
    }
    return [...value];
}
