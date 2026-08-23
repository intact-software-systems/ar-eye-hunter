import {
    decodeJsonWireValue,
    type JsonWireObject,
    type JsonWireValue
} from '../../rallar-system/protocol/json-wire-identity.ts';
import type { RuntimeStateJsonPersistenceCodec } from '../../runtime-state/runtime-state-json-persistence-provider.ts';

export function createALJsonPersistenceCodec<V>(
    label: string,
    decodeValue: (input: JsonWireValue) => V
): RuntimeStateJsonPersistenceCodec<V> {
    return {
        encode(value) {
            return normalizeJsonWireValue(value, label);
        },
        decode(value) {
            return decodeValue(value);
        }
    };
}

export function isRecord(
    input: JsonWireValue | object | undefined
): input is JsonWireObject {
    return typeof input === 'object' && input !== null && !Array.isArray(input);
}

export function hasOnlyKeys(
    input: JsonWireObject,
    allowedKeys: readonly string[]
): boolean {
    const allowed = new Set(allowedKeys);
    return Object.keys(input).every((key) => allowed.has(key));
}

export function isString(input: JsonWireValue | undefined): input is string {
    return typeof input === 'string';
}

export function isOptionalString(input: JsonWireValue | undefined): boolean {
    return input === undefined || isString(input);
}

export function isStringArray(input: JsonWireValue | undefined): input is readonly string[] {
    return Array.isArray(input) && input.every(isString);
}

export function isOptionalStringArray(input: JsonWireValue | undefined): boolean {
    return input === undefined || isStringArray(input);
}

export function isFiniteNumber(input: JsonWireValue | undefined): input is number {
    return typeof input === 'number' && Number.isFinite(input) && !Object.is(input, -0);
}

export function isOptionalFiniteNumber(input: JsonWireValue | undefined): boolean {
    return input === undefined || isFiniteNumber(input);
}

export function isOneOf<const Value extends string>(
    input: JsonWireValue | undefined,
    allowed: readonly Value[]
): input is Value {
    return typeof input === 'string' && allowed.includes(input as Value);
}

export function isJsonWireRecord(input: JsonWireValue | undefined): boolean {
    return isRecord(input);
}

function normalizeJsonWireValue<V>(value: V, label: string): JsonWireValue {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
        throw new TypeError(`${label} cannot be represented as JSON`);
    }
    return decodeJsonWireValue(JSON.parse(serialized), label);
}
