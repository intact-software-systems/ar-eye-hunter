import type { JsonWireObject, JsonWireValue } from '../protocol/json-wire-identity.ts';

export function isNoticeWireRecord(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A notice record carries exactly its contract's keys; an extra or missing key makes it another kind of notice. */
export function hasExactNoticeWireKeys(record: JsonWireObject, keys: readonly string[]): boolean {
    return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

export function isNonEmptyNoticeWireString(value: JsonWireValue): value is string {
    return typeof value === 'string' && value.length > 0;
}
