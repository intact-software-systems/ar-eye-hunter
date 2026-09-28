import type { RelicGameState } from '@relic-hunters/mod.ts';
import { encodeJsonWireValue, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';

/**
 * The rules hold an optional field as undefined (no administrator yet, no round running, an event without an
 * animation cue); the stored state leaves such a field out, as JSON has no undefined and decodeRelicGameStateAppData
 * reads the absence back. Every other value still has to be JSON-safe.
 */
export function encodeRelicGameStateAppData(state: RelicGameState): JsonWireValue {
    return encodeJsonWireValue(omitUndefinedProperties(state), 'Relic game state');
}

function omitUndefinedProperties<Value>(value: Value): Value {
    if (Array.isArray(value)) {
        return value.map((item) => omitUndefinedProperties(item)) as Value;
    }
    if (value === null || typeof value !== 'object') {
        return value;
    }
    return Object.fromEntries(
        Object.entries(value)
            .filter(([, property]) => property !== undefined)
            .map(([key, property]) => [key, omitUndefinedProperties(property)])
    ) as Value;
}
