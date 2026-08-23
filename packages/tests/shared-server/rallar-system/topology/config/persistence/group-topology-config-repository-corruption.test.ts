import { describe, expect, it, vi } from 'vitest';

import { GroupTopologyConfigRepositoryInvariantCorruptionError } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository-contracts.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import {
    GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
    GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
    GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
    GROUP_TOPOLOGY_CONFIG_NAMESPACE,
    GROUP_TOPOLOGY_OVERRIDE_NAMESPACE
} from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-runtime-namespaces.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { FakeRuntimeStateRepository } from '../../../../fake-runtime-state-repository.ts';
import { createTopologyTestEffectiveConfig, createTopologyTestGroupRef } from './group-topology-config-persistence-test-fixtures.ts';

describe('group topology config repository corruption handling', () => {
    it('wraps malformed live JSON as repository corruption', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new ExposedLiveValueRepository(runtimeRepository);
        await runtimeRepository.insertIfAbsent(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            'malformed',
            '{',
            NEVER_EXPIRE_AT_TIMESTAMP
        );
        const entry = await runtimeRepository.findEntry(GROUP_TOPOLOGY_CONFIG_NAMESPACE, 'malformed');

        await expect(
            repository.readLiveValue(GROUP_TOPOLOGY_CONFIG_NAMESPACE, entry!)
        ).rejects.toBeInstanceOf(GroupTopologyConfigRepositoryInvariantCorruptionError);
    });

    it('rejects a malformed noncanonical row with an extra field', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef = createTopologyTestGroupRef('workspace-1');
        await runtimeRepository.insertIfAbsent(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            repository.configKey(groupRef),
            JSON.stringify({
                groupRef,
                config: createTopologyTestEffectiveConfig('tree'),
                version: 1,
                createdAtEpochMs: 1,
                updatedAtEpochMs: 1,
                updatedByPrincipalId: 'noncanonical-owner',
                unexpected: true
            }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );

        await expect(repository.findConfig(groupRef)).rejects.toThrow(
            'Stored topology config fields are invalid'
        );
    });

    it('rejects a generation backfill source with a missing group ref safely', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef = createTopologyTestGroupRef('workspace-1');
        await runtimeRepository.insertIfAbsent(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            repository.configKey(groupRef),
            JSON.stringify({ version: 7 }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );

        await expect(repository.listGenerationSources('config')).rejects.toThrow(
            'Stored topology config generation source groupRef is invalid'
        );
    });

    it('fails closed before lazy expiry can delete a wrong-scope override', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_000);
        try {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new GroupTopologyConfigRepository(runtimeRepository);
            const requested = createTopologyTestGroupRef('workspace-1');
            const wrongScope = createTopologyTestGroupRef('workspace-2');
            const key = repository.overrideKey(requested);
            await runtimeRepository.insertIfAbsent(
                GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
                key,
                JSON.stringify({
                    groupRef: wrongScope,
                    config: createTopologyTestEffectiveConfig('tree'),
                    version: 7,
                    createdAtEpochMs: 1,
                    updatedAtEpochMs: 1,
                    updatedByPrincipalId: 'noncanonical-owner',
                    requestId: null,
                    expiresAtEpochMs: 1_000
                }),
                1_000
            );

            await expect(repository.findOverride(requested)).rejects.toThrow(
                'identity differs from the generation-source value'
            );
            expect(
                await runtimeRepository.findEntry(GROUP_TOPOLOGY_OVERRIDE_NAMESPACE, key)
            ).toBeDefined();
        }
        finally {
            vi.useRealTimers();
        }
    });

    it.each(['mutation record', 'target generation', 'invariant generation'] as const)(
        'validates an expired %s value before lazy expiry and preserves corruption',
        async (boundary) => {
            vi.useFakeTimers();
            vi.setSystemTime(2_000);
            try {
                const { runtimeRepository, seeded } = createExpiredCorruptionScenario(boundary);
                await runtimeRepository.insertIfAbsent(
                    seeded.namespace,
                    seeded.key,
                    JSON.stringify(seeded.value),
                    1_000
                );

                await expect(seeded.read()).rejects.toBeInstanceOf(
                    GroupTopologyConfigRepositoryInvariantCorruptionError
                );
                expect(await runtimeRepository.findEntry(seeded.namespace, seeded.key)).toBeDefined();
            }
            finally {
                vi.useRealTimers();
            }
        }
    );

    it.each(['mutation record', 'target generation', 'invariant generation'] as const)(
        'requires the %s physical row to be non-expiring',
        async (boundary) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new GroupTopologyConfigRepository(runtimeRepository);
            const groupRef = createTopologyTestGroupRef('workspace-1');
            const requestId = 'retained-ttl';
            const commandHash = `sha256:${'9'.repeat(64)}`;
            const seeded = boundary === 'mutation record'
                ? {
                    namespace: GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
                    key: repository.mutationKey(groupRef, requestId),
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
                    read: () => repository.findMutationRecord(groupRef, requestId)
                }
                : boundary === 'target generation'
                ? {
                    namespace: GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
                    key: repository.generationKey(groupRef, 'config'),
                    value: { groupRef, target: 'config', version: 1 },
                    read: () => repository.findGenerationEntry(groupRef, 'config')
                }
                : {
                    namespace: GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
                    key: repository.invariantGenerationKey(groupRef),
                    value: { groupRef, version: 1 },
                    read: () => repository.findInvariantGenerationEntry(groupRef)
                };
            await runtimeRepository.insertIfAbsent(
                seeded.namespace,
                seeded.key,
                JSON.stringify(seeded.value),
                NEVER_EXPIRE_AT_TIMESTAMP - 1
            );

            await expect(seeded.read()).rejects.toBeInstanceOf(
                GroupTopologyConfigRepositoryInvariantCorruptionError
            );
            expect(await runtimeRepository.findEntry(seeded.namespace, seeded.key)).toBeDefined();
        }
    );

    it.each([
        { target: 'config' as const, boundary: 'direct' as const },
        { target: 'config' as const, boundary: 'source' as const },
        { target: 'override' as const, boundary: 'direct' as const },
        { target: 'override' as const, boundary: 'source' as const }
    ])(
        'requires $target physical expiry to agree at the $boundary boundary',
        async ({ target, boundary }) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new GroupTopologyConfigRepository(runtimeRepository);
            const groupRef = createTopologyTestGroupRef('workspace-1');
            const namespace = target === 'config' ? GROUP_TOPOLOGY_CONFIG_NAMESPACE : GROUP_TOPOLOGY_OVERRIDE_NAMESPACE;
            const key = target === 'config' ? repository.configKey(groupRef) : repository.overrideKey(groupRef);
            const value = {
                groupRef,
                config: createTopologyTestEffectiveConfig('tree'),
                version: 1,
                createdAtEpochMs: 1,
                updatedAtEpochMs: 1,
                updatedByPrincipalId: 'owner',
                requestId: null,
                ...(target === 'override' ? { expiresAtEpochMs: 20_000 } : {})
            };
            await runtimeRepository.insertIfAbsent(
                namespace,
                key,
                JSON.stringify(value),
                target === 'config' ? NEVER_EXPIRE_AT_TIMESTAMP - 1 : 10_000
            );

            const read = boundary === 'source'
                ? repository.findGenerationSource(groupRef, target)
                : target === 'config'
                ? repository.findConfig(groupRef)
                : repository.findOverride(groupRef);
            await expect(read).rejects.toBeInstanceOf(
                GroupTopologyConfigRepositoryInvariantCorruptionError
            );
            expect(await runtimeRepository.findEntry(namespace, key)).toBeDefined();
        }
    );
});

type ExpiredCorruptionBoundary = 'mutation record' | 'target generation' | 'invariant generation';

interface ExpiredCorruptionSeed {
    readonly namespace: string;
    readonly key: string;
    readonly value: unknown;
    readonly read: () => Promise<unknown>;
}

function createExpiredCorruptionScenario(boundary: ExpiredCorruptionBoundary) {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const repository = new GroupTopologyConfigRepository(runtimeRepository);
    const groupRef = createTopologyTestGroupRef('workspace-1');
    const wrongRef = createTopologyTestGroupRef('workspace-2');
    const seeded = createExpiredCorruptionSeed(repository, groupRef, wrongRef, boundary);
    return { runtimeRepository, seeded };
}

function createExpiredCorruptionSeed(
    repository: GroupTopologyConfigRepository,
    groupRef: ReturnType<typeof createTopologyTestGroupRef>,
    wrongRef: ReturnType<typeof createTopologyTestGroupRef>,
    boundary: ExpiredCorruptionBoundary
): ExpiredCorruptionSeed {
    if (boundary === 'mutation record') {
        return createExpiredMutationRecordSeed(repository, groupRef);
    }
    if (boundary === 'target generation') {
        return {
            namespace: GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
            key: repository.generationKey(groupRef, 'config'),
            value: { groupRef, target: 'override', version: 1 },
            read: () => repository.findGenerationEntry(groupRef, 'config')
        };
    }
    return {
        namespace: GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
        key: repository.invariantGenerationKey(groupRef),
        value: { groupRef: wrongRef, version: 1 },
        read: () => repository.findInvariantGenerationEntry(groupRef)
    };
}

function createExpiredMutationRecordSeed(
    repository: GroupTopologyConfigRepository,
    groupRef: ReturnType<typeof createTopologyTestGroupRef>
): ExpiredCorruptionSeed {
    const commandHash = `sha256:${'f'.repeat(64)}`;
    const requestId = 'different-request';
    return {
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

class ExposedLiveValueRepository extends GroupTopologyConfigRepository {
    readLiveValue(namespace: string, entry: RuntimeStateEntry) {
        return this.toLiveEntryValue<unknown>(namespace, entry);
    }
}
