import type { GroupRef } from '@shared/api/group-types.ts';

import { groupStateGroupStorageKey } from '../../../group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import type { GroupTopologyConfigGenerationTarget } from '../mutation/group-topology-config-mutation-contracts.ts';
import { toGroupTopologyConfigRepositoryCorruption } from './group-topology-config-repository-contracts.ts';
import { assertGroupTopologyRef, decodeGroupTopologyStorageKey } from './group-topology-storage-slot.ts';

interface GroupTopologyChildStorageKey {
    readonly groupRef: GroupRef;
    readonly value: string;
}

export function groupTopologyGenerationStorageKey(
    ref: GroupRef,
    target: GroupTopologyConfigGenerationTarget
): string {
    return groupTopologyChildStorageKey(ref, 'target', target);
}

export function groupTopologyInvariantGenerationStorageKey(ref: GroupRef): string {
    return groupTopologyChildStorageKey(ref, 'invariant', 'effective-config');
}

export function assertGroupTopologyGenerationStorageSlot(
    storageKey: string,
    trustedRef: GroupRef,
    trustedTarget: GroupTopologyConfigGenerationTarget
): GroupRef & Readonly<{ target: GroupTopologyConfigGenerationTarget; }> {
    const decoded = decodeGroupTopologyGenerationStorageKey(storageKey);
    assertGroupTopologyRef({
        actual: decoded,
        expected: trustedRef,
        storageKey,
        slot: 'requested generation slot'
    });
    if (decoded.target !== trustedTarget) {
        throw toGroupTopologyConfigRepositoryCorruption(
            storageKey,
            'Stored topology config generation target differs from the requested slot'
        );
    }
    return decoded;
}

export function assertGroupTopologyInvariantStorageSlot(
    storageKey: string,
    trustedRef: GroupRef
): GroupRef {
    const decoded = decodeGroupTopologyInvariantGenerationStorageKey(storageKey);
    assertGroupTopologyRef({
        actual: decoded,
        expected: trustedRef,
        storageKey,
        slot: 'requested invariant-generation slot'
    });
    return decoded;
}

function groupTopologyChildStorageKey(ref: GroupRef, name: string, value: string): string {
    return `${groupStateGroupStorageKey(ref)}:${name}=${encodeURIComponent(value)}`;
}

function decodeGroupTopologyGenerationStorageKey(
    storageKey: string
): GroupRef & Readonly<{ target: GroupTopologyConfigGenerationTarget; }> {
    const decoded = decodeGroupTopologyChildStorageKey(storageKey, 'target');
    if (decoded.value !== 'config' && decoded.value !== 'override') {
        throw toGroupTopologyConfigRepositoryCorruption(
            storageKey,
            'Stored topology config generation target is invalid'
        );
    }
    return { ...decoded.groupRef, target: decoded.value };
}

function decodeGroupTopologyInvariantGenerationStorageKey(storageKey: string): GroupRef {
    const decoded = decodeGroupTopologyChildStorageKey(storageKey, 'invariant');
    if (decoded.value !== 'effective-config') {
        throw toGroupTopologyConfigRepositoryCorruption(
            storageKey,
            'Stored topology config invariant slot is invalid'
        );
    }
    return decoded.groupRef;
}

function decodeGroupTopologyChildStorageKey(
    storageKey: string,
    name: string
): GroupTopologyChildStorageKey {
    const parts = storageKey.split(':');
    if (parts.length !== 4) {
        throw toGroupTopologyConfigRepositoryCorruption(
            storageKey,
            `Stored topology config ${name} key has invalid arity`
        );
    }
    const groupRef = decodeGroupTopologyStorageKey(parts.slice(0, 3).join(':'));
    const prefix = `${name}=`;
    if (!parts[3]?.startsWith(prefix)) {
        throw toGroupTopologyConfigRepositoryCorruption(
            storageKey,
            `Stored topology config key is missing ${name}`
        );
    }
    let value: string;
    try {
        value = decodeURIComponent(parts[3].slice(prefix.length));
    }
    catch {
        throw toGroupTopologyConfigRepositoryCorruption(
            storageKey,
            `Stored topology config key has invalid ${name} encoding`
        );
    }
    if (groupTopologyChildStorageKey(groupRef, name, value) !== storageKey) {
        throw toGroupTopologyConfigRepositoryCorruption(
            storageKey,
            `Stored topology config ${name} key is not canonical`
        );
    }
    return { groupRef, value };
}
