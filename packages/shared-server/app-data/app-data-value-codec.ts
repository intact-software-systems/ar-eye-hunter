import { decodeJsonWireValue, type JsonWireValue } from '../rallar-system/protocol/json-wire-identity.ts';
import { AppDataCorruptionError } from './app-data-corruption-error.ts';
import type { AppDataEntry } from './app-data-repository.ts';

export interface AppDataValueCodec<V> {
    readonly schemaVersion: number;
    encode(value: V): JsonWireValue;
    decode(value: JsonWireValue): V;
}

export function assertAppDataValueCodec<V>(codec: AppDataValueCodec<V>): void {
    if (!Number.isInteger(codec.schemaVersion) || codec.schemaVersion < 0) {
        throw new Error('Rallar server app data codec schemaVersion must be a non-negative integer.');
    }
}

export function encodeAppDataValue<V>(codec: AppDataValueCodec<V>, value: V): JsonWireValue {
    return decodeJsonWireValue(codec.encode(value), 'Encoded app data value');
}

export function decodeCurrentAppDataValue<V>(
    codec: AppDataValueCodec<V>,
    entry: AppDataEntry
): V {
    if (entry.schemaVersion !== codec.schemaVersion) {
        throw new AppDataCorruptionError({
            entry,
            reason: `has schema version ${entry.schemaVersion}; expected ${codec.schemaVersion}.`
        });
    }

    try {
        return codec.decode(entry.value);
    }
    catch (error) {
        throw new AppDataCorruptionError({
            entry,
            reason: 'does not match its current codec.',
            cause: error instanceof Error
                ? error
                : new Error('App data codec threw a non-Error value.')
        });
    }
}
