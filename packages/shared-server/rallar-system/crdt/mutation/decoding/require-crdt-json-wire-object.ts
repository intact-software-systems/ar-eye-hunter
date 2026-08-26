import type { JsonWireObject, JsonWireValue } from '../../../protocol/json-wire-identity.ts';

export function requireCrdtJsonWireObject(
    value: JsonWireValue | undefined,
    label: string
): JsonWireObject {
    if (
        value === null ||
        value === undefined ||
        typeof value !== 'object' ||
        isJsonWireArray(value)
    ) {
        throw new TypeError(`${label} must be an exact object`);
    }
    return value;
}

function isJsonWireArray(value: JsonWireValue): value is readonly JsonWireValue[] {
    return Array.isArray(value);
}
