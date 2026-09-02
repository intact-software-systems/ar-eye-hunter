import { describe, expect, it } from 'vitest';

import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GroupTopologyConfigRepositoryInvariantCorruptionError } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository-contracts.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import {
    GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
    GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
    GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
    GROUP_TOPOLOGY_CONFIG_NAMESPACE,
    GROUP_TOPOLOGY_OVERRIDE_NAMESPACE
} from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-runtime-namespaces.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { FakeRuntimeStateRepository } from '../../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import {
    createTopologyTestEffectiveConfig,
    createTopologyTestGroupRef,
    PhysicalKeyAliasingRuntimeStateRepository
} from './group-topology-config-persistence-test-fixtures.ts';

describe('group topology config repository scope isolation', () => {
    it('rejects noncanonical physical keys at list and page boundaries', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef: GroupRef = {
            applicationId: 'app-1',
            workspaceId: '_',
            groupId: 'room-1'
        };
        const noncanonicalKey = groupStateGroupStorageKey(groupRef).replace('app=app-1', 'app=%61pp-1');
        await runtimeRepository.insertIfAbsent(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            noncanonicalKey,
            JSON.stringify({
                groupRef,
                config: createTopologyTestEffectiveConfig('tree'),
                version: 1,
                createdAtEpochMs: 1,
                updatedAtEpochMs: 1,
                updatedByPrincipalId: 'owner',
                requestId: null
            }),
            new Date(NEVER_EXPIRE_AT_TIMESTAMP).toISOString()
        );

        await expect(repository.listGenerationSources('config')).rejects.toThrow('not canonical');
        await expect(repository.listGenerationSourcesPage('config', { limit: 1 })).rejects.toThrow(
            'not canonical'
        );
    });

    it('rejects a noncanonical physical key at every direct repository boundary', async () => {
        const boundaries = createCanonicalBoundaryContracts();

        for (const boundary of boundaries) {
            const runtimeRepository = new PhysicalKeyAliasingRuntimeStateRepository();
            const repository = new GroupTopologyConfigRepository(runtimeRepository);
            await boundary.seed(repository);
            runtimeRepository.aliasedNamespace = boundary.namespace;

            await expect(boundary.read(repository), boundary.label).rejects.toBeInstanceOf(
                GroupTopologyConfigRepositoryInvariantCorruptionError
            );
        }
    });

    it('rejects wrong stored scope or child identity at every direct boundary', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const boundaries = createWrongStoredBoundaryContracts(repository);

        for (const boundary of boundaries) {
            await runtimeRepository.insertIfAbsent(
                boundary.namespace,
                boundary.key,
                JSON.stringify(boundary.value),
                new Date(NEVER_EXPIRE_AT_TIMESTAMP).toISOString()
            );
            await expect(boundary.read(), boundary.label).rejects.toBeInstanceOf(
                GroupTopologyConfigRepositoryInvariantCorruptionError
            );
        }
    });

    it('isolates identical group IDs across complete application and workspace scope', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const refs: readonly GroupRef[] = [
            { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' },
            { applicationId: 'app-2', workspaceId: 'workspace-1', groupId: 'room-1' },
            { applicationId: 'app-1', workspaceId: 'workspace-2', groupId: 'room-1' },
            { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-2' }
        ];

        for (const [index, groupRef] of refs.entries()) {
            await repository.commitConfig(
                {
                    groupRef,
                    config: createTopologyTestEffectiveConfig('tree'),
                    version: index + 1,
                    createdAtEpochMs: 1,
                    updatedAtEpochMs: index + 1,
                    updatedByPrincipalId: 'owner',
                    requestId: `scope-${index}`
                },
                null
            );
        }

        await expect(Promise.all(refs.map((ref) => repository.findConfig(ref)))).resolves.toEqual(
            refs.map((groupRef, index) => ({
                groupRef,
                config: createTopologyTestEffectiveConfig('tree'),
                version: index + 1,
                createdAtEpochMs: 1,
                updatedAtEpochMs: index + 1,
                updatedByPrincipalId: 'owner',
                requestId: `scope-${index}`
            }))
        );
        expect(new Set(refs.map((ref) => repository.configKey(ref)))).toHaveLength(4);
    });
});

interface CanonicalRepositoryBoundary {
    readonly label: string;
    readonly namespace: string;
    readonly seed: (repository: GroupTopologyConfigRepository) => Promise<object | undefined>;
    readonly read: (repository: GroupTopologyConfigRepository) => Promise<object | undefined>;
}

interface WrongStoredRepositoryBoundary {
    readonly label: string;
    readonly namespace: string;
    readonly key: string;
    readonly value: object;
    readonly read: () => Promise<object | undefined>;
}

function createCanonicalBoundaryContracts(): readonly CanonicalRepositoryBoundary[] {
    const groupRef = createTopologyTestGroupRef('workspace-1');
    return [
        ...createCanonicalConfigBoundaryContracts(groupRef),
        createCanonicalMutationBoundaryContract(groupRef),
        ...createCanonicalGenerationBoundaryContracts(groupRef)
    ];
}

function createCanonicalConfigBoundaryContracts(
    groupRef: GroupRef
): readonly CanonicalRepositoryBoundary[] {
    const config = {
        groupRef,
        config: createTopologyTestEffectiveConfig('tree'),
        version: 1,
        createdAtEpochMs: 1,
        updatedAtEpochMs: 1,
        updatedByPrincipalId: 'owner'
    };
    return [
        {
            label: 'config',
            namespace: GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            seed: (repository) => repository.commitConfig({ ...config, requestId: 'config-boundary' }, null),
            read: (repository) => repository.findConfig(groupRef)
        },
        {
            label: 'override',
            namespace: GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
            seed: (repository) =>
                repository.commitOverride(
                    {
                        ...config,
                        requestId: 'override-boundary',
                        expiresAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP
                    },
                    null
                ),
            read: (repository) => repository.findOverride(groupRef)
        }
    ];
}

function createCanonicalMutationBoundaryContract(groupRef: GroupRef): CanonicalRepositoryBoundary {
    const commandHash = `sha256:${'d'.repeat(64)}`;
    const requestId = 'mutation-boundary';
    return {
        label: 'mutation record',
        namespace: GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
        seed: (repository) =>
            repository.insertMutationRecord({
                groupRef,
                requestId,
                commandHash,
                receipt: {
                    commandId: requestId,
                    requestId,
                    commandHash,
                    operation: 'deleteConfig',
                    outcome: 'no-op',
                    attemptCount: 1,
                    groupRef,
                    target: 'config',
                    acceptedVersion: 0,
                    acceptedStorageRevision: null,
                    acceptedCreatedAtEpochMs: null,
                    acceptedUpdatedAtEpochMs: null,
                    acceptedExpiresAtEpochMs: null,
                    acceptedConfig: null,
                    acceptedCausalRevision: null,
                    eventId: null,
                    outboxIds: []
                }
            }),
        read: (repository) => repository.findMutationRecord(groupRef, requestId)
    };
}

function createCanonicalGenerationBoundaryContracts(
    groupRef: GroupRef
): readonly CanonicalRepositoryBoundary[] {
    return [
        {
            label: 'target generation',
            namespace: GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
            seed: (repository) => repository.commitGeneration({ groupRef, target: 'config', version: 1 }, null),
            read: (repository) => repository.findGenerationEntry(groupRef, 'config')
        },
        {
            label: 'invariant generation',
            namespace: GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
            seed: (repository) => repository.commitInvariantGeneration({ groupRef, version: 1 }, null),
            read: (repository) => repository.findInvariantGenerationEntry(groupRef)
        }
    ];
}

function createWrongStoredBoundaryContracts(
    repository: GroupTopologyConfigRepository
): readonly WrongStoredRepositoryBoundary[] {
    const groupRef = createTopologyTestGroupRef('workspace-1');
    const wrongRef = createTopologyTestGroupRef('workspace-2');
    return [
        ...createWrongStoredConfigBoundaries(repository, groupRef, wrongRef),
        createWrongStoredMutationBoundary(repository, groupRef),
        ...createWrongStoredGenerationBoundaries(repository, groupRef, wrongRef)
    ];
}

function createWrongStoredConfigBoundaries(
    repository: GroupTopologyConfigRepository,
    groupRef: GroupRef,
    wrongRef: GroupRef
): readonly WrongStoredRepositoryBoundary[] {
    const config = {
        groupRef: wrongRef,
        config: createTopologyTestEffectiveConfig('tree'),
        version: 1,
        createdAtEpochMs: 1,
        updatedAtEpochMs: 1,
        updatedByPrincipalId: 'owner'
    };
    return [
        {
            label: 'config scope',
            namespace: GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            key: repository.configKey(groupRef),
            value: { ...config, requestId: 'wrong-config-scope' },
            read: () => repository.findConfig(groupRef)
        },
        {
            label: 'override scope',
            namespace: GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
            key: repository.overrideKey(groupRef),
            value: {
                ...config,
                requestId: 'wrong-override-scope',
                expiresAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP
            },
            read: () => repository.findOverride(groupRef)
        }
    ];
}

function createWrongStoredMutationBoundary(
    repository: GroupTopologyConfigRepository,
    groupRef: GroupRef
): WrongStoredRepositoryBoundary {
    const commandHash = `sha256:${'e'.repeat(64)}`;
    const requestId = 'different-request';
    return {
        label: 'mutation request child',
        namespace: GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
        key: repository.mutationKey(groupRef, 'expected-request'),
        value: {
            groupRef,
            requestId,
            commandHash,
            receipt: {
                commandId: requestId,
                commandHash,
                operation: 'deleteConfig',
                outcome: 'no-op',
                groupRef,
                target: 'config',
                acceptedVersion: 0,
                acceptedStorageRevision: null,
                acceptedCreatedAtEpochMs: null,
                acceptedUpdatedAtEpochMs: null,
                acceptedExpiresAtEpochMs: null,
                acceptedConfig: null,
                acceptedCausalRevision: null
            }
        },
        read: () => repository.findMutationRecord(groupRef, 'expected-request')
    };
}

function createWrongStoredGenerationBoundaries(
    repository: GroupTopologyConfigRepository,
    groupRef: GroupRef,
    wrongRef: GroupRef
): readonly WrongStoredRepositoryBoundary[] {
    return [
        {
            label: 'generation target child',
            namespace: GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
            key: repository.generationKey(groupRef, 'config'),
            value: { groupRef, target: 'override', version: 1 },
            read: () => repository.findGenerationEntry(groupRef, 'config')
        },
        {
            label: 'invariant scope',
            namespace: GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
            key: repository.invariantGenerationKey(groupRef),
            value: { groupRef: wrongRef, version: 1 },
            read: () => repository.findInvariantGenerationEntry(groupRef)
        }
    ];
}
