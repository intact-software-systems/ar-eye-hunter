import type { GroupRef } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import type { RuntimeStateEntry } from '../../../../runtime-state/runtime-state-repository.ts';
import type { JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import type {
    GroupTopologyConfigGeneration,
    GroupTopologyConfigGenerationTarget,
    GroupTopologyConfigInvariantGeneration,
    GroupTopologyConfigMutationRecord
} from '../mutation/group-topology-config-mutation-contracts.ts';
import * as configBoundary from '../mutation/topology-config-mutation-boundary.ts';
import {
    decodeStoredGroupTopologyJsonValue,
    withGroupTopologyConfigCorruption
} from './group-topology-config-json-decoding.ts';
import { toGroupTopologyConfigRepositoryCorruption } from './group-topology-config-repository-contracts.ts';
import {
    assertGroupTopologyGenerationStorageSlot,
    assertGroupTopologyInvariantStorageSlot
} from './group-topology-generation-storage-keys.ts';
import { assertGroupTopologyMutationStorageSlot } from './group-topology-mutation-storage-key.ts';
import { assertGroupTopologyRef } from './group-topology-storage-slot.ts';

export function decodeGroupTopologyMutationEntry(
    entry: RuntimeStateEntry,
    trustedRef: GroupRef,
    trustedRequestId: string
): GroupTopologyConfigMutationRecord {
    return decodeGroupTopologyMutationValue({
        entry,
        value: decodeStoredGroupTopologyJsonValue(entry, 'Stored topology mutation record'),
        trustedRef,
        trustedRequestId
    });
}

export interface DecodeGroupTopologyMutationValueInput {
    readonly entry: RuntimeStateEntry;
    readonly value: JsonWireValue;
    readonly trustedRef: GroupRef;
    readonly trustedRequestId: string;
}

export function decodeGroupTopologyMutationValue(
    input: DecodeGroupTopologyMutationValueInput
): GroupTopologyConfigMutationRecord {
    const { entry, value, trustedRef, trustedRequestId } = input;
    const decoded = assertGroupTopologyMutationStorageSlot(entry.key, trustedRef, trustedRequestId);
    const expected = { groupRef: decoded, requestId: decoded.requestId };
    const record = withGroupTopologyConfigCorruption(
        entry.key,
        () => configBoundary.readTopologyConfigMutationRecordBoundary(value, expected)
    );
    assertGroupTopologyRef({
        actual: record.groupRef,
        expected: decoded,
        storageKey: entry.key,
        slot: 'mutation value'
    });
    return record;
}

export function decodeGroupTopologyGenerationEntry(
    entry: RuntimeStateEntry,
    trustedRef: GroupRef,
    trustedTarget: GroupTopologyConfigGenerationTarget
): GroupTopologyConfigGeneration {
    return decodeGroupTopologyGenerationValue({
        entry,
        value: decodeStoredGroupTopologyJsonValue(entry, 'Stored topology generation'),
        trustedRef,
        trustedTarget
    });
}

export interface DecodeGroupTopologyGenerationValueInput {
    readonly entry: RuntimeStateEntry;
    readonly value: JsonWireValue;
    readonly trustedRef: GroupRef;
    readonly trustedTarget: GroupTopologyConfigGenerationTarget;
}

export function decodeGroupTopologyGenerationValue(
    input: DecodeGroupTopologyGenerationValueInput
): GroupTopologyConfigGeneration {
    const { entry, value, trustedRef, trustedTarget } = input;
    const decoded = assertGroupTopologyGenerationStorageSlot(entry.key, trustedRef, trustedTarget);
    const generation = withGroupTopologyConfigCorruption(
        entry.key,
        () => configBoundary.readTopologyConfigGenerationBoundary(value, decoded, decoded.target)
    );
    assertGroupTopologyRef({
        actual: generation.groupRef,
        expected: decoded,
        storageKey: entry.key,
        slot: 'generation value'
    });
    return generation;
}

export function decodeGroupTopologyInvariantEntry(
    entry: RuntimeStateEntry,
    trustedRef: GroupRef
): GroupTopologyConfigInvariantGeneration {
    return decodeGroupTopologyInvariantValue(
        entry,
        decodeStoredGroupTopologyJsonValue(entry, 'Stored topology invariant generation'),
        trustedRef
    );
}

export function decodeGroupTopologyInvariantValue(
    entry: RuntimeStateEntry,
    value: JsonWireValue,
    trustedRef: GroupRef
): GroupTopologyConfigInvariantGeneration {
    const decoded = assertGroupTopologyInvariantStorageSlot(entry.key, trustedRef);
    const generation = withGroupTopologyConfigCorruption(
        entry.key,
        () => configBoundary.readTopologyConfigInvariantGenerationBoundary(value, decoded)
    );
    assertGroupTopologyRef({
        actual: generation.groupRef,
        expected: decoded,
        storageKey: entry.key,
        slot: 'invariant-generation value'
    });
    return generation;
}

export function assertRetainedGroupTopologyEntry(entry: RuntimeStateEntry, label: string): void {
    if (entry.expireAtTimestamp !== NEVER_EXPIRE_AT_TIMESTAMP) {
        throw toGroupTopologyConfigRepositoryCorruption(
            entry.key,
            `Stored topology config ${label} must not expire`
        );
    }
}
