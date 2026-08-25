import type { JsonWireValue } from '../../../protocol/json-wire-identity.ts';

export function decodeExactProjectionIds(value: JsonWireValue): readonly string[] {
    if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id.length === 0)) {
        throw new TypeError('CRDT projection IDs are invalid');
    }
    if (new Set(value).size !== value.length) {
        throw new TypeError('CRDT projection IDs must be unique');
    }
    return value as readonly string[];
}
