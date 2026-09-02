import type { GroupRef } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { encodeRuntimeStateJsonValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import { materializeGroupStateAuthorityGuard } from '../../../group-state/persistence/aggregate/group-aggregate-repository.ts';
import { GROUPS_NAMESPACE } from '../../../group-state/persistence/group-state-runtime-namespaces.ts';
import {
    GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
    GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
    GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
    GROUP_TOPOLOGY_CONFIG_NAMESPACE,
    GROUP_TOPOLOGY_OVERRIDE_NAMESPACE
} from '../persistence/group-topology-config-runtime-namespaces.ts';
import {
    groupTopologyGenerationStorageKey,
    groupTopologyInvariantGenerationStorageKey
} from '../persistence/group-topology-generation-storage-keys.ts';
import { groupTopologyMutationStorageKey } from '../persistence/group-topology-mutation-storage-key.ts';
import {
    groupTopologyConfigStorageKey,
    groupTopologyOverrideStorageKey
} from '../persistence/group-topology-source-storage-keys.ts';
import type {
    GroupTopologyConfigMutationClaimComputed,
    GroupTopologyConfigMutationWriteComputed,
    TopologyConfigRuntimeWrite,
    TopologyConfigWriteGuard
} from './group-topology-config-mutation-contracts.ts';

type TopologyConfigRuntimeWriteSource =
    | Omit<GroupTopologyConfigMutationWriteComputed, 'runtimeWrites'>
    | Omit<GroupTopologyConfigMutationClaimComputed, 'runtimeWrites'>;

export function computeTopologyConfigRuntimeWrites(
    computed: TopologyConfigRuntimeWriteSource
): readonly TopologyConfigRuntimeWrite[] {
    const writes: TopologyConfigRuntimeWrite[] = [authorityFenceWrite(computed)];
    if (computed.outcome === 'write') {
        writes.push(
            targetWrite(computed.guard, computed.receipt.groupRef),
            valueWrite({
                namespace: GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
                key: groupTopologyInvariantGenerationStorageKey(
                    computed.invariantGenerationGuard.value.groupRef
                ),
                value: computed.invariantGenerationGuard.value,
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
                expectedRevision: computed.invariantGenerationGuard.expectedRevision
            }),
            valueWrite({
                namespace: GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
                key: groupTopologyGenerationStorageKey(
                    computed.generationGuard.value.groupRef,
                    computed.generationGuard.value.target
                ),
                value: computed.generationGuard.value,
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
                expectedRevision: computed.generationGuard.expectedRevision
            })
        );
    }
    if (computed.idempotency !== null) {
        writes.push(valueWrite({
            namespace: GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
            key: groupTopologyMutationStorageKey(
                computed.idempotency.groupRef,
                computed.idempotency.requestId
            ),
            value: computed.idempotency,
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
            expectedRevision: null
        }));
    }
    return writes;
}

function authorityFenceWrite(
    computed: TopologyConfigRuntimeWriteSource
): TopologyConfigRuntimeWrite {
    const fence = materializeGroupStateAuthorityGuard(computed.groupAuthorityGuard);
    return {
        operation: 'update',
        namespace: GROUPS_NAMESPACE,
        key: fence.key,
        value: fence.value,
        expireAtIsoTimestamp: new Date(fence.expireAtTimestamp).toISOString(),
        expectedRevision: fence.expectedRevision,
        expectedResultRevision: fence.expectedRevision + 1
    };
}

function targetWrite(
    guard: TopologyConfigWriteGuard,
    groupRef: GroupRef
): TopologyConfigRuntimeWrite {
    const namespace = guard.target === 'config'
        ? GROUP_TOPOLOGY_CONFIG_NAMESPACE
        : GROUP_TOPOLOGY_OVERRIDE_NAMESPACE;
    const key = guard.target === 'config'
        ? groupTopologyConfigStorageKey(groupRef)
        : groupTopologyOverrideStorageKey(groupRef);
    if (guard.operation === 'delete') {
        return {
            operation: 'delete',
            namespace,
            key,
            expectedRevision: guard.expectedRevision
        };
    }
    return valueWrite({
        namespace,
        key,
        value: guard.value,
        expireAtTimestamp: guard.target === 'override'
            ? guard.value.expiresAtEpochMs
            : NEVER_EXPIRE_AT_TIMESTAMP,
        expectedRevision: guard.expectedRevision
    });
}

function valueWrite(
    input: Readonly<{
        namespace: string;
        key: string;
        value: object;
        expireAtTimestamp: number;
        expectedRevision: number | null;
    }>
): TopologyConfigRuntimeWrite {
    const value = encodeRuntimeStateJsonValue(input.value);
    return input.expectedRevision === null
        ? {
            operation: 'insert',
            namespace: input.namespace,
            key: input.key,
            value,
            expireAtIsoTimestamp: new Date(input.expireAtTimestamp).toISOString(),
            expectedResultRevision: 0
        }
        : {
            operation: 'update',
            namespace: input.namespace,
            key: input.key,
            value,
            expireAtIsoTimestamp: new Date(input.expireAtTimestamp).toISOString(),
            expectedRevision: input.expectedRevision,
            expectedResultRevision: input.expectedRevision + 1
        };
}

