import type {
    StoredGroupTopologyConfig,
    StoredGroupTopologyOverride
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import type { RuntimeStateEntryValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntry } from '../../../../runtime-state/runtime-state-repository.ts';
import type { JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import type { GroupTopologyConfigGenerationTarget } from '../mutation/group-topology-config-mutation-contracts.ts';
import {
    decodeStoredGroupTopologyConfig,
    decodeStoredGroupTopologyOverride,
    storedTopologyGroupRef
} from './decode-stored-group-topology-config.ts';
import {
    decodeStoredGroupTopologyJsonValue,
    withGroupTopologyConfigCorruption
} from './group-topology-config-json-decoding.ts';
import {
    toGroupTopologyConfigRepositoryCorruption,
    type GroupTopologyConfigGenerationSourceEntry
} from './group-topology-config-repository-contracts.ts';
import { assertGroupTopologyRef, decodeGroupTopologyStorageKey } from './group-topology-config-storage-keys.ts';

export function decodeCanonicalGroupTopologyGenerationSourceEntry(
    entry: RuntimeStateEntry,
    target: GroupTopologyConfigGenerationTarget,
    trustedRef?: GroupRef
): GroupTopologyConfigGenerationSourceEntry {
    const decoded = decodeGroupTopologyStorageKey(entry.key);
    if (trustedRef) {
        assertGroupTopologyRef({
            actual: decoded,
            expected: trustedRef,
            storageKey: entry.key,
            slot: 'requested generation-source slot'
        });
    }
    const value = decodeGroupTopologySourceValue(entry, target, decoded);
    assertGroupTopologyRef({
        actual: value.groupRef,
        expected: decoded,
        storageKey: entry.key,
        slot: 'generation-source value'
    });
    return {
        entry,
        source: { groupRef: decoded, target, version: value.version },
        value
    };
}

export function assertCanonicalGroupTopologySourceEntry(
    entry: RuntimeStateEntry,
    target: GroupTopologyConfigGenerationTarget,
    trustedRef: GroupRef
): void {
    decodeCanonicalGroupTopologyGenerationSourceEntry(entry, target, trustedRef);
}

export function toValidatedLiveGroupTopologySourceEntry(
    stored: RuntimeStateEntryValue<JsonWireValue>,
    target: 'config',
    trustedRef: GroupRef
): RuntimeStateEntryValue<StoredGroupTopologyConfig>;
export function toValidatedLiveGroupTopologySourceEntry(
    stored: RuntimeStateEntryValue<JsonWireValue>,
    target: 'override',
    trustedRef: GroupRef
): RuntimeStateEntryValue<StoredGroupTopologyOverride>;
export function toValidatedLiveGroupTopologySourceEntry(
    stored: RuntimeStateEntryValue<JsonWireValue>,
    target: GroupTopologyConfigGenerationTarget,
    trustedRef: GroupRef
): RuntimeStateEntryValue<StoredGroupTopologyConfig | StoredGroupTopologyOverride> {
    const entry = { ...stored.entry, value: JSON.stringify(stored.value) };
    const validated = decodeCanonicalGroupTopologyGenerationSourceEntry(entry, target, trustedRef);
    return { entry: stored.entry, value: validated.value };
}

function decodeGroupTopologySourceValue(
    entry: RuntimeStateEntry,
    target: GroupTopologyConfigGenerationTarget,
    expectedRef?: GroupRef
): StoredGroupTopologyConfig | StoredGroupTopologyOverride {
    const parsed = decodeStoredGroupTopologyJsonValue(entry, 'Stored topology generation source');
    const storedRef = withGroupTopologyConfigCorruption(
        entry.key,
        () => storedTopologyGroupRef(parsed)
    );
    if (expectedRef) {
        assertGroupTopologyRef({
            actual: storedRef,
            expected: expectedRef,
            storageKey: entry.key,
            slot: 'generation-source value'
        });
    }
    if (target === 'config') {
        const value = withGroupTopologyConfigCorruption(
            entry.key,
            () => decodeStoredGroupTopologyConfig(parsed, storedRef)
        );
        assertGroupTopologySourceExpiry(entry, NEVER_EXPIRE_AT_TIMESTAMP, target);
        return value;
    }
    const value = withGroupTopologyConfigCorruption(
        entry.key,
        () => decodeStoredGroupTopologyOverride(parsed, storedRef)
    );
    assertGroupTopologySourceExpiry(entry, value.expiresAtEpochMs, target);
    return value;
}

function assertGroupTopologySourceExpiry(
    entry: RuntimeStateEntry,
    expectedExpiry: number,
    target: GroupTopologyConfigGenerationTarget
): void {
    if (entry.expireAtTimestamp !== expectedExpiry) {
        throw toGroupTopologyConfigRepositoryCorruption(
            entry.key,
            `Stored topology ${target} physical expiry differs from its value contract`
        );
    }
}
