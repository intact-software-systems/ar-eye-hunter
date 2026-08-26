import type { RuntimeStateEntry } from '../../../../runtime-state/runtime-state-repository.ts';
import { decodeJsonWireValue, type JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import {
    GroupTopologyConfigRepositoryInvariantCorruptionError,
    toGroupTopologyConfigRepositoryCorruption
} from './group-topology-config-repository-contracts.ts';

export function decodeStoredGroupTopologyJsonValue(
    entry: RuntimeStateEntry,
    label: string
): JsonWireValue {
    return withGroupTopologyConfigCorruption(
        entry.key,
        () => decodeJsonWireValue(JSON.parse(entry.value), label)
    );
}

export async function readGroupTopologyJsonValue<T>(
    entry: RuntimeStateEntry,
    read: () => Promise<T>
): Promise<T> {
    try {
        return await read();
    }
    catch (error) {
        if (error instanceof GroupTopologyConfigRepositoryInvariantCorruptionError) {
            throw error;
        }
        throw toGroupTopologyConfigRepositoryCorruption(
            entry.key,
            `Stored topology config JSON is invalid: ${error instanceof Error ? error.message : 'invalid JSON'}`
        );
    }
}

export function withGroupTopologyConfigCorruption<T>(
    storageKey: string,
    decode: () => T
): T {
    try {
        return decode();
    }
    catch (error) {
        if (error instanceof GroupTopologyConfigRepositoryInvariantCorruptionError) {
            throw error;
        }
        throw toGroupTopologyConfigRepositoryCorruption(
            storageKey,
            error instanceof Error ? error.message : 'Stored topology config value is invalid'
        );
    }
}
