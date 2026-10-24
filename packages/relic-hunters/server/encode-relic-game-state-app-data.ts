import type { RelicGameState } from '@relic-hunters/mod.ts';
import { encodeJsonWireValue, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';

/**
 * The rules hold an optional field as undefined (no administrator yet, no round running, an event without an
 * animation cue); the stored state leaves such a field out, as JSON has no undefined and decodeRelicGameStateAppData
 * reads the absence back. Only the undefined properties of plain objects are left out, through plain objects and
 * arrays; every other value, a cycle included, reaches the JSON-safety check as it is.
 */
export function encodeRelicGameStateAppData(state: RelicGameState): JsonWireValue {
    return encodeJsonWireValue(omitUndefinedPlainProperties(state, new Set()), 'Relic game state');
}

function omitUndefinedPlainProperties<Value>(value: Value, ancestors: ReadonlySet<object>): Value {
    if (!isPlainContainer(value) || ancestors.has(value)) {
        return value;
    }
    const path = new Set(ancestors).add(value);
    if (Array.isArray(value)) {
        return value.map((item) => omitUndefinedPlainProperties(item, path)) as Value;
    }
    return Object.fromEntries(
        Object.entries(value)
            .filter(([, property]) => property !== undefined)
            .map(([key, property]) => [key, omitUndefinedPlainProperties(property, path)])
    ) as Value;
}

function isPlainContainer(value: unknown): value is object {
    if (Array.isArray(value)) {
        return true;
    }
    if (value === null || typeof value !== 'object') {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
