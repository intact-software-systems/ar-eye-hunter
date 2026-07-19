import { describe, expect, it, vi } from 'vitest';
import type { GroupRef } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import {
    groupStateGroupStorageKey,
    groupStateIdempotencyStorageKey,
} from '@shared-server/rallar-system/group-state-storage-keys.ts';
import {
    GROUP_TOPOLOGY_CONFIG_NAMESPACE,
    GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
    GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
    GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
    GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
    GroupTopologyConfigRepository,
    GroupTopologyConfigRepositoryInvariantCorruptionError,
} from '@shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts';
import {
    backfillAllGroupTopologyConfigGenerations,
    backfillGroupTopologyConfigGenerationsForRef,
    migrateLegacyGroupTopologyConfigKeys,
} from '@shared-server/rallar-system/services/group-topology-config-generation-backfill.ts';
import {
    RuntimeStateRetryExhaustedError,
} from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type {
    RuntimeStateEntry,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('group topology config repository', () => {
    it('uses canonical optional-workspace keys across every topology namespace', () => {
        const repository = new GroupTopologyConfigRepository(
            new FakeRuntimeStateRepository(),
        );
        const refs: readonly GroupRef[] = [
            { applicationId: 'app:key', groupId: 'room:key' },
            { applicationId: 'app:key', workspaceId: '_', groupId: 'room:key' },
            { applicationId: 'app:key', workspaceId: 'a:b', groupId: 'room:key' },
            { applicationId: 'app:key', workspaceId: 'a%3Ab', groupId: 'room:key' },
            { applicationId: 'app:key', workspaceId: '%5F', groupId: 'room:key' },
            { applicationId: 'app:key', workspaceId: '＿', groupId: 'room:key' },
        ];

        for (const ref of refs) {
            const groupKey = groupStateGroupStorageKey(ref);
            expect(repository.configKey(ref)).toBe(groupKey);
            expect(repository.overrideKey(ref)).toBe(groupKey);
            expect(repository.mutationKey(ref, 'request:key')).toBe(
                groupStateIdempotencyStorageKey(ref, 'request:key'),
            );
            expect(repository.generationKey(ref, 'config')).toBe(
                `${groupKey}:target=config`,
            );
            expect(repository.invariantGenerationKey(ref)).toBe(
                `${groupKey}:invariant=effective-config`,
            );
        }
        expect(new Set(refs.map((ref) => repository.configKey(ref))).size)
            .toBe(refs.length);
    });

    it('accepts an absent workspace and canonically omits it from stored values', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef: GroupRef = {
            applicationId: 'app-1',
            groupId: 'room-1',
        };
        const config = {
            groupRef,
            config: { topologyKind: 'tree' as const },
            version: 1,
            createdAtEpochMs: 1,
            updatedAtEpochMs: 1,
            updatedByPrincipalId: 'owner',
            requestId: 'absent-workspace',
        };

        await expect(repository.commitConfig(config, null)).resolves.toEqual({
            status: 'accepted',
            storageRevision: 0,
        });
        await expect(repository.findConfig(groupRef)).resolves.toEqual(config);
        const entry = await runtimeRepository.findEntry(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            groupStateGroupStorageKey(groupRef),
        );
        expect(JSON.parse(entry!.value).groupRef).toEqual({
            applicationId: 'app-1',
            groupId: 'room-1',
        });
    });

    it('decodes canonical optional-workspace sources consistently for list and page boundaries', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const refs: readonly GroupRef[] = [
            { applicationId: 'app-1', groupId: 'room-1' },
            { applicationId: 'app-1', workspaceId: '_', groupId: 'room-1' },
            { applicationId: 'app-1', workspaceId: 'a:b', groupId: 'room-1' },
            { applicationId: 'app-1', workspaceId: 'a%3Ab', groupId: 'room-1' },
            { applicationId: 'app-1', workspaceId: '＿', groupId: 'room-1' },
        ];
        for (const [index, groupRef] of refs.entries()) {
            await runtimeRepository.insertIfAbsent(
                GROUP_TOPOLOGY_CONFIG_NAMESPACE,
                groupStateGroupStorageKey(groupRef),
                JSON.stringify({
                    groupRef,
                    config: { topologyKind: 'tree' },
                    version: index + 1,
                    createdAtEpochMs: 1,
                    updatedAtEpochMs: 1,
                    updatedByPrincipalId: 'owner',
                    requestId: null,
                }),
                NEVER_EXPIRE_AT_TIMESTAMP,
            );
        }

        await expect(repository.listGenerationSources('config')).resolves.toEqual(
            refs.map((groupRef, index) => ({
                groupRef,
                target: 'config',
                version: index + 1,
            })).sort((left, right) =>
                groupStateGroupStorageKey(left.groupRef).localeCompare(
                    groupStateGroupStorageKey(right.groupRef),
                )
            ),
        );
        const first = await repository.listGenerationSourcesPage('config', {
            limit: 2,
        });
        const second = await repository.listGenerationSourcesPage('config', {
            afterKey: first.at(-1)!.entry.key,
            limit: 3,
        });
        expect([...first, ...second].map(({ source }) => source.groupRef))
            .toEqual((await repository.listGenerationSources('config')).map((source) =>
                source.groupRef
            ));
    });

    it.each([
        {
            label: 'durable config',
            namespace: GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            target: 'config' as const,
        },
        {
            label: 'temporary override',
            namespace: GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
            target: 'override' as const,
        },
    ])('decodes legacy $label rows with omitted requestId as null', async ({
        namespace,
        target,
    }) => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef = createGroupRef('workspace-1');
        const legacy = {
            groupRef,
            config: { topologyKind: 'tree' as const },
            version: 7,
            createdAtEpochMs: 1,
            updatedAtEpochMs: 2,
            updatedByPrincipalId: 'legacy-owner',
            ...(target === 'override'
                ? { expiresAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP }
                : {}),
        };
        const key = target === 'config'
            ? repository.configKey(groupRef)
            : repository.overrideKey(groupRef);
        await runtimeRepository.insertIfAbsent(
            namespace,
            key,
            JSON.stringify(legacy),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );

        const decoded = target === 'config'
            ? await repository.findConfig(groupRef)
            : await repository.findOverride(groupRef);

        expect(decoded).toEqual({ ...legacy, requestId: null });
    });

    it('does not treat a malformed legacy row with an extra field as compatible', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef = createGroupRef('workspace-1');
        await runtimeRepository.insertIfAbsent(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            repository.configKey(groupRef),
            JSON.stringify({
                groupRef,
                config: { topologyKind: 'tree' },
                version: 1,
                createdAtEpochMs: 1,
                updatedAtEpochMs: 1,
                updatedByPrincipalId: 'legacy-owner',
                unexpected: true,
            }),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );

        await expect(repository.findConfig(groupRef))
            .rejects.toThrow('Stored topology config fields are invalid');
    });

    it('rejects a generation backfill source with a missing group ref safely', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef = createGroupRef('workspace-1');
        await runtimeRepository.insertIfAbsent(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            repository.configKey(groupRef),
            JSON.stringify({ version: 7 }),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );

        await expect(repository.listGenerationSources('config')).rejects.toThrow(
            'Stored topology config generation source groupRef is invalid',
        );
    });

    it('fails closed before lazy expiry can delete a wrong-scope override', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_000);
        try {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new GroupTopologyConfigRepository(runtimeRepository);
            const requested = createGroupRef('workspace-1');
            const wrongScope = createGroupRef('workspace-2');
            const key = repository.overrideKey(requested);
            await runtimeRepository.insertIfAbsent(
                GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
                key,
                JSON.stringify({
                    groupRef: wrongScope,
                    config: { topologyKind: 'tree' },
                    version: 7,
                    createdAtEpochMs: 1,
                    updatedAtEpochMs: 1,
                    updatedByPrincipalId: 'legacy-owner',
                    requestId: null,
                    expiresAtEpochMs: 1_000,
                }),
                1_000,
            );

            await expect(repository.findOverride(requested)).rejects.toThrow(
                'identity differs from the generation-source value',
            );
            expect(await runtimeRepository.findEntry(
                GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
                key,
            )).toBeDefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([
        'mutation record',
        'target generation',
        'invariant generation',
    ] as const)(
        'validates an expired %s value before lazy expiry and preserves corruption',
        async (boundary) => {
            vi.useFakeTimers();
            vi.setSystemTime(2_000);
            try {
                const runtimeRepository = new FakeRuntimeStateRepository();
                const repository = new GroupTopologyConfigRepository(runtimeRepository);
                const groupRef = createGroupRef('workspace-1');
                const wrongRef = createGroupRef('workspace-2');
                const commandHash = `sha256:${'f'.repeat(64)}`;
                const seeded = boundary === 'mutation record'
                    ? {
                        namespace: GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
                        key: repository.mutationKey(groupRef, 'expected-request'),
                        value: {
                            groupRef,
                            requestId: 'different-request',
                            commandHash,
                            receipt: {
                                commandId: 'different-request',
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
                                outboxId: null,
                            },
                        },
                        read: () =>
                            repository.findMutationRecord(groupRef, 'expected-request'),
                    }
                    : boundary === 'target generation'
                    ? {
                        namespace: GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
                        key: repository.generationKey(groupRef, 'config'),
                        value: { groupRef, target: 'override', version: 1 },
                        read: () => repository.findGenerationEntry(groupRef, 'config'),
                    }
                    : {
                        namespace:
                            GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
                        key: repository.invariantGenerationKey(groupRef),
                        value: { groupRef: wrongRef, version: 1 },
                        read: () => repository.findInvariantGenerationEntry(groupRef),
                    };
                await runtimeRepository.insertIfAbsent(
                    seeded.namespace,
                    seeded.key,
                    JSON.stringify(seeded.value),
                    1_000,
                );

                await expect(seeded.read()).rejects.toBeInstanceOf(
                    GroupTopologyConfigRepositoryInvariantCorruptionError,
                );
                expect(await runtimeRepository.findEntry(
                    seeded.namespace,
                    seeded.key,
                )).toBeDefined();
            } finally {
                vi.useRealTimers();
            }
        },
    );

    it.each([
        'mutation record',
        'target generation',
        'invariant generation',
    ] as const)(
        'requires the %s physical row to be non-expiring',
        async (boundary) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new GroupTopologyConfigRepository(runtimeRepository);
            const groupRef = createGroupRef('workspace-1');
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
                            outboxId: null,
                        },
                    },
                    read: () => repository.findMutationRecord(groupRef, requestId),
                }
                : boundary === 'target generation'
                ? {
                    namespace: GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
                    key: repository.generationKey(groupRef, 'config'),
                    value: { groupRef, target: 'config', version: 1 },
                    read: () => repository.findGenerationEntry(groupRef, 'config'),
                }
                : {
                    namespace: GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
                    key: repository.invariantGenerationKey(groupRef),
                    value: { groupRef, version: 1 },
                    read: () => repository.findInvariantGenerationEntry(groupRef),
                };
            await runtimeRepository.insertIfAbsent(
                seeded.namespace,
                seeded.key,
                JSON.stringify(seeded.value),
                NEVER_EXPIRE_AT_TIMESTAMP - 1,
            );

            await expect(seeded.read()).rejects.toBeInstanceOf(
                GroupTopologyConfigRepositoryInvariantCorruptionError,
            );
            expect(await runtimeRepository.findEntry(seeded.namespace, seeded.key))
                .toBeDefined();
        },
    );

    it.each([
        { target: 'config' as const, boundary: 'direct' as const },
        { target: 'config' as const, boundary: 'source' as const },
        { target: 'override' as const, boundary: 'direct' as const },
        { target: 'override' as const, boundary: 'source' as const },
    ])(
        'requires $target physical expiry to agree at the $boundary boundary',
        async ({ target, boundary }) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new GroupTopologyConfigRepository(runtimeRepository);
            const groupRef = createGroupRef('workspace-1');
            const namespace = target === 'config'
                ? GROUP_TOPOLOGY_CONFIG_NAMESPACE
                : GROUP_TOPOLOGY_OVERRIDE_NAMESPACE;
            const key = target === 'config'
                ? repository.configKey(groupRef)
                : repository.overrideKey(groupRef);
            const value = {
                groupRef,
                config: { topologyKind: 'tree' as const },
                version: 1,
                createdAtEpochMs: 1,
                updatedAtEpochMs: 1,
                updatedByPrincipalId: 'owner',
                requestId: null,
                ...(target === 'override' ? { expiresAtEpochMs: 20_000 } : {}),
            };
            await runtimeRepository.insertIfAbsent(
                namespace,
                key,
                JSON.stringify(value),
                target === 'config' ? NEVER_EXPIRE_AT_TIMESTAMP - 1 : 10_000,
            );

            const read = boundary === 'source'
                ? repository.findGenerationSource(groupRef, target)
                : target === 'config'
                ? repository.findConfig(groupRef)
                : repository.findOverride(groupRef);
            await expect(read).rejects.toBeInstanceOf(
                GroupTopologyConfigRepositoryInvariantCorruptionError,
            );
            expect(await runtimeRepository.findEntry(namespace, key)).toBeDefined();
        },
    );

    it('rejects noncanonical physical keys at list and page boundaries', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef: GroupRef = {
            applicationId: 'app-1',
            workspaceId: '_',
            groupId: 'room-1',
        };
        const noncanonicalKey = groupStateGroupStorageKey(groupRef).replace('%5F', '%5f');
        await runtimeRepository.insertIfAbsent(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            noncanonicalKey,
            JSON.stringify({
                groupRef,
                config: { topologyKind: 'tree' },
                version: 1,
                createdAtEpochMs: 1,
                updatedAtEpochMs: 1,
                updatedByPrincipalId: 'owner',
                requestId: null,
            }),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );

        await expect(repository.listGenerationSources('config')).rejects.toThrow(
            'not canonical',
        );
        await expect(repository.listGenerationSourcesPage('config', { limit: 1 }))
            .rejects.toThrow('not canonical');
    });

    it('rejects a noncanonical physical key at every direct repository boundary', async () => {
        const groupRef = createGroupRef('workspace-1');
        const commandHash = `sha256:${'d'.repeat(64)}`;
        const boundaries = [
            {
                label: 'config',
                namespace: GROUP_TOPOLOGY_CONFIG_NAMESPACE,
                seed: (repository: GroupTopologyConfigRepository) =>
                    repository.commitConfig({
                        groupRef,
                        config: { topologyKind: 'tree' },
                        version: 1,
                        createdAtEpochMs: 1,
                        updatedAtEpochMs: 1,
                        updatedByPrincipalId: 'owner',
                        requestId: 'config-boundary',
                    }, null),
                read: (repository: GroupTopologyConfigRepository) =>
                    repository.findConfig(groupRef),
            },
            {
                label: 'override',
                namespace: GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
                seed: (repository: GroupTopologyConfigRepository) =>
                    repository.commitOverride({
                        groupRef,
                        config: { topologyKind: 'tree' },
                        version: 1,
                        createdAtEpochMs: 1,
                        updatedAtEpochMs: 1,
                        updatedByPrincipalId: 'owner',
                        requestId: 'override-boundary',
                        expiresAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP,
                    }, null),
                read: (repository: GroupTopologyConfigRepository) =>
                    repository.findOverride(groupRef),
            },
            {
                label: 'mutation record',
                namespace: GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
                seed: (repository: GroupTopologyConfigRepository) =>
                    repository.insertMutationRecord({
                        groupRef,
                        requestId: 'mutation-boundary',
                        commandHash,
                        receipt: {
                            commandId: 'mutation-boundary',
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
                            outboxId: null,
                        },
                    }),
                read: (repository: GroupTopologyConfigRepository) =>
                    repository.findMutationRecord(groupRef, 'mutation-boundary'),
            },
            {
                label: 'target generation',
                namespace: GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
                seed: (repository: GroupTopologyConfigRepository) =>
                    repository.commitGeneration({
                        groupRef,
                        target: 'config',
                        version: 1,
                    }, null),
                read: (repository: GroupTopologyConfigRepository) =>
                    repository.findGenerationEntry(groupRef, 'config'),
            },
            {
                label: 'invariant generation',
                namespace: GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
                seed: (repository: GroupTopologyConfigRepository) =>
                    repository.commitInvariantGeneration({
                        groupRef,
                        version: 1,
                    }, null),
                read: (repository: GroupTopologyConfigRepository) =>
                    repository.findInvariantGenerationEntry(groupRef),
            },
        ] as const;

        for (const boundary of boundaries) {
            const runtimeRepository = new PhysicalKeyAliasingRuntimeStateRepository();
            const repository = new GroupTopologyConfigRepository(runtimeRepository);
            await boundary.seed(repository);
            runtimeRepository.aliasedNamespace = boundary.namespace;

            await expect(boundary.read(repository), boundary.label).rejects
                .toBeInstanceOf(
                    GroupTopologyConfigRepositoryInvariantCorruptionError,
                );
        }
    });

    it('rejects wrong stored scope or child identity at every direct boundary', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef = createGroupRef('workspace-1');
        const wrongRef = createGroupRef('workspace-2');
        const commandHash = `sha256:${'e'.repeat(64)}`;
        const boundaries = [
            {
                label: 'config scope',
                namespace: GROUP_TOPOLOGY_CONFIG_NAMESPACE,
                key: repository.configKey(groupRef),
                value: {
                    groupRef: wrongRef,
                    config: { topologyKind: 'tree' },
                    version: 1,
                    createdAtEpochMs: 1,
                    updatedAtEpochMs: 1,
                    updatedByPrincipalId: 'owner',
                    requestId: 'wrong-config-scope',
                },
                read: () => repository.findConfig(groupRef),
            },
            {
                label: 'override scope',
                namespace: GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
                key: repository.overrideKey(groupRef),
                value: {
                    groupRef: wrongRef,
                    config: { topologyKind: 'tree' },
                    version: 1,
                    createdAtEpochMs: 1,
                    updatedAtEpochMs: 1,
                    updatedByPrincipalId: 'owner',
                    requestId: 'wrong-override-scope',
                    expiresAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP,
                },
                read: () => repository.findOverride(groupRef),
            },
            {
                label: 'mutation request child',
                namespace: GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
                key: repository.mutationKey(groupRef, 'expected-request'),
                value: {
                    groupRef,
                    requestId: 'different-request',
                    commandHash,
                    receipt: {
                        commandId: 'different-request',
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
                        outboxId: null,
                    },
                },
                read: () =>
                    repository.findMutationRecord(groupRef, 'expected-request'),
            },
            {
                label: 'generation target child',
                namespace: GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
                key: repository.generationKey(groupRef, 'config'),
                value: { groupRef, target: 'override', version: 1 },
                read: () => repository.findGenerationEntry(groupRef, 'config'),
            },
            {
                label: 'invariant scope',
                namespace: GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
                key: repository.invariantGenerationKey(groupRef),
                value: { groupRef: wrongRef, version: 1 },
                read: () => repository.findInvariantGenerationEntry(groupRef),
            },
        ] as const;

        for (const boundary of boundaries) {
            await runtimeRepository.insertIfAbsent(
                boundary.namespace,
                boundary.key,
                JSON.stringify(boundary.value),
                NEVER_EXPIRE_AT_TIMESTAMP,
            );
            await expect(boundary.read(), boundary.label).rejects.toBeInstanceOf(
                GroupTopologyConfigRepositoryInvariantCorruptionError,
            );
        }
    });

    it('commits config and overrides only against the observed storage revision', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef = createGroupRef('workspace-1');
        const first = {
            groupRef,
            config: { topologyKind: 'tree' as const },
            version: 1,
            createdAtEpochMs: 1,
            updatedAtEpochMs: 1,
            updatedByPrincipalId: 'owner',
            requestId: 'config-1',
        };
        const second = {
            ...first,
            config: { topologyKind: 'mesh' as const },
            version: 2,
            updatedAtEpochMs: 2,
            requestId: 'config-2',
        };

        expect(await repository.commitConfig(first, null)).toEqual({
            status: 'accepted',
            storageRevision: 0,
        });
        expect(await repository.commitConfig(second, null)).toEqual({
            status: 'conflict',
        });
        expect(await repository.commitConfig(second, 0)).toEqual({
            status: 'accepted',
            storageRevision: 1,
        });
        expect(await repository.deleteConfig(groupRef, 0)).toEqual({
            status: 'conflict',
        });
        expect(await repository.deleteConfig(groupRef, 1)).toEqual({
            status: 'accepted',
        });

        const override = {
            ...first,
            requestId: 'override-1',
            expiresAtEpochMs: 10_000,
        };
        expect(await repository.commitOverride(override, null)).toEqual({
            status: 'accepted',
            storageRevision: 0,
        });
        expect(await repository.deleteOverride(groupRef, 1)).toEqual({
            status: 'conflict',
        });
        expect(await repository.deleteOverride(groupRef, 0)).toEqual({
            status: 'accepted',
        });
    });

    it('rejects a persisted mutation record whose receipt commandId differs from requestId', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef = createGroupRef('workspace-1');
        const requestId = 'expected-request';
        const commandHash = `sha256:${'a'.repeat(64)}`;
        await runtimeRepository.insertIfAbsent(
            GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
            repository.mutationKey(groupRef, requestId),
            JSON.stringify({
                groupRef,
                requestId,
                commandHash,
                receipt: {
                    commandId: 'different-request',
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
                    outboxId: null,
                },
            }),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );

        await expect(repository.findMutationRecord(groupRef, requestId))
            .rejects.toThrow('receipt commandId differs from requestId');
    });

    it.each([
        {
            label: 'operation-target mismatch',
            receipt: { operation: 'putConfig', target: 'override' },
            message: 'operation target is invalid',
        },
        {
            label: 'applied missing accepted storage revision',
            receipt: {
                outcome: 'applied',
                acceptedVersion: 1,
                acceptedStorageRevision: null,
                outboxId: 'state-mutation-invalid',
            },
            message: 'applied receipt is incomplete',
        },
        {
            label: 'applied zero accepted version',
            receipt: {
                outcome: 'applied',
                acceptedVersion: 0,
                acceptedStorageRevision: 0,
                outboxId: 'state-mutation-invalid',
            },
            message: 'applied receipt is incomplete',
        },
    ])('rejects persisted $label payloads', async ({ receipt, message }, index) => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef = createGroupRef('workspace-1');
        const requestId = `invalid-receipt-${index}`;
        const commandHash = `sha256:${'b'.repeat(64)}`;
        await runtimeRepository.insertIfAbsent(
            GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
            repository.mutationKey(groupRef, requestId),
            JSON.stringify({
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
                    outboxId: null,
                    ...receipt,
                },
            }),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );

        await expect(repository.findMutationRecord(groupRef, requestId))
            .rejects.toThrow(message);
    });

    it.each(['putConfig', 'putOverride'] as const)(
        'rejects a persisted impossible %s no-op receipt as typed corruption',
        async (operation) => {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new GroupTopologyConfigRepository(runtimeRepository);
            const groupRef = createGroupRef('workspace-1');
            const requestId = `persisted-impossible-${operation}`;
            const commandHash = `sha256:${'6'.repeat(64)}`;
            await runtimeRepository.insertIfAbsent(
                GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
                repository.mutationKey(groupRef, requestId),
                JSON.stringify({
                    groupRef,
                    requestId,
                    commandHash,
                    receipt: {
                        commandId: requestId,
                        commandHash,
                        operation,
                        outcome: 'no-op',
                        groupRef,
                        target: operation === 'putConfig' ? 'config' : 'override',
                        acceptedVersion: 1,
                        acceptedStorageRevision: null,
                        acceptedCreatedAtEpochMs: 1_000,
                        acceptedUpdatedAtEpochMs: 1_000,
                        acceptedExpiresAtEpochMs: operation === 'putOverride'
                            ? 6_000
                            : null,
                        outboxId: null,
                    },
                }),
                NEVER_EXPIRE_AT_TIMESTAMP,
            );

            await expect(repository.findMutationRecord(groupRef, requestId))
                .rejects.toBeInstanceOf(
                    GroupTopologyConfigRepositoryInvariantCorruptionError,
                );
        },
    );

    it.each([
        {
            label: 'put receipt without replay timestamps',
            receipt: {
                acceptedCreatedAtEpochMs: null,
                acceptedUpdatedAtEpochMs: null,
            },
            message: 'receipt timestamps do not match operation',
        },
        {
            label: 'config receipt with override expiry',
            receipt: { acceptedExpiresAtEpochMs: 2 },
            message: 'receipt expiry does not match operation',
        },
    ])('rejects persisted $label', async ({ receipt, message }) => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef = createGroupRef('workspace-1');
        const requestId = 'expected-request';
        const commandHash = `sha256:${'c'.repeat(64)}`;
        await runtimeRepository.insertIfAbsent(
            GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
            repository.mutationKey(groupRef, requestId),
            JSON.stringify({
                groupRef,
                requestId,
                commandHash,
                receipt: {
                    commandId: requestId,
                    commandHash,
                    operation: 'putConfig',
                    outcome: 'applied',
                    groupRef,
                    target: 'config',
                    acceptedVersion: 1,
                    acceptedStorageRevision: 0,
                    acceptedCreatedAtEpochMs: 1,
                    acceptedUpdatedAtEpochMs: 1,
                    acceptedExpiresAtEpochMs: null,
                    outboxId: 'state-mutation-valid-shape',
                    ...receipt,
                },
            }),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );

        await expect(repository.findMutationRecord(groupRef, requestId))
            .rejects.toThrow(message);
    });

    it('conditionally advances a retained per-target generation record', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef = createGroupRef('workspace-1');
        const first = { groupRef, target: 'config' as const, version: 1 };
        const second = { ...first, version: 2 };

        expect(await repository.commitGeneration(first, null)).toEqual({
            status: 'accepted',
            storageRevision: 0,
        });
        expect(await repository.commitGeneration(second, null)).toEqual({
            status: 'conflict',
        });
        expect(await repository.commitGeneration(second, 0)).toEqual({
            status: 'accepted',
            storageRevision: 1,
        });
        expect(await repository.findGenerationEntry(groupRef, 'config'))
            .toMatchObject({ value: second, entry: { revision: 1 } });
        expect(runtimeRepository.data.has(
            `${GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE}::${repository.generationKey(groupRef, 'config')}`,
        )).toBe(true);
    });

    it('optimistically backfills config and expired override generations without deleting sources', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_000);
        try {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new GroupTopologyConfigRepository(runtimeRepository);
            const groupRef = createGroupRef('workspace-1');
            const legacyConfig = {
                groupRef,
                config: { topologyKind: 'tree' as const },
                version: 6,
                createdAtEpochMs: 1,
                updatedAtEpochMs: 1,
                updatedByPrincipalId: 'legacy-owner',
            };
            const legacyOverride = {
                ...legacyConfig,
                version: 7,
                expiresAtEpochMs: 1_500,
            };
            await runtimeRepository.insertIfAbsent(
                GROUP_TOPOLOGY_CONFIG_NAMESPACE,
                repository.configKey(groupRef),
                JSON.stringify(legacyConfig),
                NEVER_EXPIRE_AT_TIMESTAMP,
            );
            await runtimeRepository.insertIfAbsent(
                GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
                repository.overrideKey(groupRef),
                JSON.stringify(legacyOverride),
                legacyOverride.expiresAtEpochMs,
            );

            await expect(backfillAllGroupTopologyConfigGenerations(repository, {
                sleep: () => Promise.resolve(),
            })).resolves.toEqual({ scanned: 2, advanced: 2 });
            await expect(repository.findGenerationEntry(groupRef, 'config'))
                .resolves.toMatchObject({ value: { version: 6 } });
            await expect(repository.findGenerationEntry(groupRef, 'override'))
                .resolves.toMatchObject({ value: { version: 7 } });
            expect(await runtimeRepository.findEntry(
                GROUP_TOPOLOGY_CONFIG_NAMESPACE,
                repository.configKey(groupRef),
            )).toBeDefined();
            expect(await runtimeRepository.findEntry(
                GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
                repository.overrideKey(groupRef),
            )).toBeDefined();
            expect(runtimeRepository.locks).toEqual([]);

            await expect(backfillAllGroupTopologyConfigGenerations(repository, {
                sleep: () => Promise.resolve(),
            })).resolves.toEqual({ scanned: 2, advanced: 0 });
        } finally {
            vi.useRealTimers();
        }
    });

    it('migrates a value-verified explicit-sentinel legacy source before generation backfill', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef: GroupRef = {
            applicationId: 'app-1',
            workspaceId: '_',
            groupId: 'room-1',
        };
        const legacyKey = 'app=app-1:ws=_:group=room-1';
        const canonicalKey = groupStateGroupStorageKey(groupRef);
        const legacy = {
            groupRef,
            config: { topologyKind: 'tree' as const },
            version: 7,
            createdAtEpochMs: 1,
            updatedAtEpochMs: 1,
            updatedByPrincipalId: 'legacy-owner',
        };
        await runtimeRepository.insertIfAbsent(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            legacyKey,
            JSON.stringify(legacy),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );

        await expect(migrateLegacyGroupTopologyConfigKeys(
            repository,
            { oldWritersStopped: true, sleep: () => Promise.resolve() },
        )).resolves.toBeUndefined();
        await expect(backfillAllGroupTopologyConfigGenerations(repository, {
            sleep: () => Promise.resolve(),
        })).resolves.toEqual({ scanned: 1, advanced: 1 });
        expect(await runtimeRepository.findEntry(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            legacyKey,
        )).toBeUndefined();
        expect(await runtimeRepository.findEntry(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            canonicalKey,
        )).toMatchObject({ value: JSON.stringify(legacy) });
        await expect(repository.findGenerationEntry(groupRef, 'config'))
            .resolves.toMatchObject({ value: { version: 7 } });
        expect(runtimeRepository.locks).toEqual([]);
    });

    it('keeps ordinary per-ref readiness fail-closed without moving a legacy key', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef: GroupRef = {
            applicationId: 'app-1',
            workspaceId: '_',
            groupId: 'room-1',
        };
        const legacyKey = 'app=app-1:ws=_:group=room-1';
        const canonicalKey = groupStateGroupStorageKey(groupRef);
        await runtimeRepository.insertIfAbsent(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            legacyKey,
            JSON.stringify({
                groupRef,
                config: { topologyKind: 'tree' },
                version: 7,
                createdAtEpochMs: 1,
                updatedAtEpochMs: 1,
                updatedByPrincipalId: 'legacy-owner',
            }),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );

        await expect(backfillGroupTopologyConfigGenerationsForRef(
            repository,
            groupRef,
            { sleep: () => Promise.resolve() },
        )).rejects.toMatchObject({
            code: 'group-topology-config-legacy-key-migration-required',
        });
        await expect(backfillAllGroupTopologyConfigGenerations(repository, {
            sleep: () => Promise.resolve(),
        })).rejects.toMatchObject({
            code: 'group-topology-config-repository-invariant-corruption',
        });
        expect(await runtimeRepository.findEntry(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            legacyKey,
        )).toBeDefined();
        expect(await runtimeRepository.findEntry(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            canonicalKey,
        )).toBeUndefined();
        expect(runtimeRepository.locks).toEqual([]);
    });

    it('does not claim an absent-workspace legacy source for the explicit sentinel', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const absentRef: GroupRef = {
            applicationId: 'app-1',
            groupId: 'room-1',
        };
        const sentinelRef: GroupRef = { ...absentRef, workspaceId: '_' };
        const source = {
            groupRef: absentRef,
            config: { topologyKind: 'tree' as const },
            version: 7,
            createdAtEpochMs: 1,
            updatedAtEpochMs: 1,
            updatedByPrincipalId: 'legacy-owner',
        };
        await runtimeRepository.insertIfAbsent(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            groupStateGroupStorageKey(absentRef),
            JSON.stringify(source),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );

        await expect(backfillGroupTopologyConfigGenerationsForRef(
            repository,
            sentinelRef,
            { sleep: () => Promise.resolve() },
        )).resolves.toEqual({ scanned: 0, advanced: 0 });
        expect(await runtimeRepository.findEntry(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            groupStateGroupStorageKey(absentRef),
        )).toBeDefined();
    });

    it('fails closed without deleting a different-content canonical migration winner', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef: GroupRef = {
            applicationId: 'app-1',
            workspaceId: '_',
            groupId: 'room-1',
        };
        const legacyKey = 'app=app-1:ws=_:group=room-1';
        const source = {
            groupRef,
            config: { topologyKind: 'tree' as const },
            version: 7,
            createdAtEpochMs: 1,
            updatedAtEpochMs: 1,
            updatedByPrincipalId: 'legacy-owner',
        };
        const winner = {
            ...source,
            config: { topologyKind: 'mesh' as const },
            version: 8,
            updatedAtEpochMs: 2,
        };
        await runtimeRepository.insertIfAbsent(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            legacyKey,
            JSON.stringify(source),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );
        await runtimeRepository.insertIfAbsent(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            groupStateGroupStorageKey(groupRef),
            JSON.stringify(winner),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );

        await expect(migrateLegacyGroupTopologyConfigKeys(
            repository,
            { oldWritersStopped: true, sleep: () => Promise.resolve() },
        )).rejects.toThrow('legacy key migration destination differs');
        expect(await runtimeRepository.findEntry(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            legacyKey,
        )).toBeDefined();
        expect(await runtimeRepository.findEntry(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            groupStateGroupStorageKey(groupRef),
        )).toMatchObject({ value: JSON.stringify(winner) });
    });

    it('removes a semantically identical normalized migration duplicate', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef: GroupRef = {
            applicationId: 'app-1',
            workspaceId: '_',
            groupId: 'room-1',
        };
        const legacyKey = 'app=app-1:ws=_:group=room-1';
        const source = {
            groupRef,
            config: { topologyKind: 'tree' as const, degreeLimit: 4 },
            version: 7,
            createdAtEpochMs: 1,
            updatedAtEpochMs: 1,
            updatedByPrincipalId: 'legacy-owner',
        };
        await runtimeRepository.insertIfAbsent(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            legacyKey,
            JSON.stringify(source),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );
        await runtimeRepository.insertIfAbsent(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            groupStateGroupStorageKey(groupRef),
            JSON.stringify({
                requestId: null,
                updatedByPrincipalId: source.updatedByPrincipalId,
                updatedAtEpochMs: source.updatedAtEpochMs,
                createdAtEpochMs: source.createdAtEpochMs,
                version: source.version,
                config: { degreeLimit: 4, topologyKind: 'tree' },
                groupRef: {
                    groupId: groupRef.groupId,
                    workspaceId: groupRef.workspaceId,
                    applicationId: groupRef.applicationId,
                },
            }),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );

        await expect(migrateLegacyGroupTopologyConfigKeys(
            repository,
            { oldWritersStopped: true, sleep: () => Promise.resolve() },
        )).resolves.toBeUndefined();
        await expect(backfillAllGroupTopologyConfigGenerations(repository, {
            sleep: () => Promise.resolve(),
        })).resolves.toEqual({ scanned: 1, advanced: 1 });
        expect(await runtimeRepository.findEntry(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            legacyKey,
        )).toBeUndefined();
        await expect(repository.findConfig(groupRef)).resolves.toEqual({
            ...source,
            requestId: null,
        });
    });

    it('rolls back a migration destination when the observed source revision changes', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef: GroupRef = {
            applicationId: 'app-1',
            workspaceId: '_',
            groupId: 'room-1',
        };
        const legacyKey = 'app=app-1:ws=_:group=room-1';
        const canonicalKey = groupStateGroupStorageKey(groupRef);
        const source = {
            groupRef,
            config: { topologyKind: 'tree' as const },
            version: 7,
            createdAtEpochMs: 1,
            updatedAtEpochMs: 1,
            updatedByPrincipalId: 'legacy-owner',
        };
        await runtimeRepository.insertIfAbsent(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            legacyKey,
            JSON.stringify(source),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );
        const conflict = async (
            operation: 'insertIfAbsent' | 'upsertIfRevision' | 'deleteIfRevision',
            namespace: string,
            key: string,
        ) => {
            if (
                operation !== 'deleteIfRevision' ||
                namespace !== GROUP_TOPOLOGY_CONFIG_NAMESPACE ||
                key !== legacyKey
            ) return;
            runtimeRepository.beforeConditionalWrite = undefined;
            await runtimeRepository.upsertIfRevision(
                namespace,
                key,
                JSON.stringify(source),
                NEVER_EXPIRE_AT_TIMESTAMP,
                0,
            );
            runtimeRepository.beforeConditionalWrite = conflict;
        };
        runtimeRepository.beforeConditionalWrite = conflict;

        await expect(migrateLegacyGroupTopologyConfigKeys(
            repository,
            { oldWritersStopped: true, sleep: () => Promise.resolve() },
        )).rejects.toBeInstanceOf(RuntimeStateRetryExhaustedError);
        expect(await runtimeRepository.findEntry(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            canonicalKey,
        )).toBeUndefined();
        expect(await runtimeRepository.findEntry(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            legacyKey,
        )).toMatchObject({ revision: 0 });
        expect(runtimeRepository.locks).toEqual([]);
    });

    it('pages all legacy migration candidates before generation backfill', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const refs = Array.from({ length: 101 }, (_, index): GroupRef => ({
            applicationId: 'app-1',
            workspaceId: '_',
            groupId: `room-${String(index).padStart(3, '0')}`,
        }));
        for (const [index, groupRef] of refs.entries()) {
            await runtimeRepository.insertIfAbsent(
                GROUP_TOPOLOGY_CONFIG_NAMESPACE,
                `app=app-1:ws=_:group=${groupRef.groupId}`,
                JSON.stringify({
                    groupRef,
                    config: { topologyKind: 'tree' },
                    version: index + 1,
                    createdAtEpochMs: 1,
                    updatedAtEpochMs: 1,
                    updatedByPrincipalId: 'legacy-owner',
                }),
                NEVER_EXPIRE_AT_TIMESTAMP,
            );
        }

        await expect(migrateLegacyGroupTopologyConfigKeys(
            repository,
            { oldWritersStopped: true, sleep: () => Promise.resolve() },
        )).resolves.toBeUndefined();
        await expect(backfillAllGroupTopologyConfigGenerations(repository, {
            sleep: () => Promise.resolve(),
        })).resolves.toEqual({ scanned: 101, advanced: 101 });
        for (const groupRef of refs) {
            expect(await runtimeRepository.findEntry(
                GROUP_TOPOLOGY_CONFIG_NAMESPACE,
                `app=app-1:ws=_:group=${groupRef.groupId}`,
            )).toBeUndefined();
            expect(await runtimeRepository.findEntry(
                GROUP_TOPOLOGY_CONFIG_NAMESPACE,
                groupStateGroupStorageKey(groupRef),
            )).toBeDefined();
        }
        expect(runtimeRepository.locks).toEqual([]);
    });

    it('does not downgrade a generation that wins a backfill conflict', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef = createGroupRef('workspace-1');
        await runtimeRepository.insertIfAbsent(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            repository.configKey(groupRef),
            JSON.stringify({
                groupRef,
                config: { topologyKind: 'tree' },
                version: 7,
                createdAtEpochMs: 1,
                updatedAtEpochMs: 1,
                updatedByPrincipalId: 'legacy-owner',
            }),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );
        runtimeRepository.beforeConditionalWrite = async (
            operation,
            namespace,
            key,
        ) => {
            if (
                operation !== 'insertIfAbsent' ||
                namespace !== GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE
            ) return;
            runtimeRepository.beforeConditionalWrite = undefined;
            await runtimeRepository.insertIfAbsent(
                namespace,
                key,
                JSON.stringify({ groupRef, target: 'config', version: 8 }),
                NEVER_EXPIRE_AT_TIMESTAMP,
            );
        };

        await expect(backfillGroupTopologyConfigGenerationsForRef(
            repository,
            groupRef,
            { sleep: () => Promise.resolve() },
        )).resolves.toEqual({ scanned: 1, advanced: 0 });
        await expect(repository.findGenerationEntry(groupRef, 'config'))
            .resolves.toMatchObject({ value: { version: 8 } });
        expect(runtimeRepository.locks).toEqual([]);
    });

    it('conditionally advances the retained aggregate invariant generation', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef = createGroupRef('workspace-1');
        const first = { groupRef, version: 1 };
        const second = { groupRef, version: 2 };

        expect(await repository.commitInvariantGeneration(first, null)).toEqual({
            status: 'accepted',
            storageRevision: 0,
        });
        expect(await repository.commitInvariantGeneration(second, null)).toEqual({
            status: 'conflict',
        });
        expect(await repository.commitInvariantGeneration(second, 0)).toEqual({
            status: 'accepted',
            storageRevision: 1,
        });
        expect(await repository.findInvariantGenerationEntry(groupRef))
            .toMatchObject({
                value: second,
                entry: {
                    key: repository.invariantGenerationKey(groupRef),
                    revision: 1,
                },
            });
    });

    it('returns a refreshed override when stale expiry cleanup loses its revision guard', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_000);
        try {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new GroupTopologyConfigRepository(runtimeRepository);
            const groupRef = createGroupRef('workspace-1');
            const stale = {
                groupRef,
                config: { topologyKind: 'tree' as const },
                version: 1,
                createdAtEpochMs: 1,
                updatedAtEpochMs: 1,
                updatedByPrincipalId: 'owner',
                requestId: 'override-stale',
                expiresAtEpochMs: 1_000,
            };
            const refreshed = {
                ...stale,
                config: { topologyKind: 'mesh' as const },
                version: 2,
                updatedAtEpochMs: 2_000,
                requestId: 'override-refreshed',
                expiresAtEpochMs: 10_000,
            };
            await repository.commitOverride(stale, null);
            let replaced = false;
            runtimeRepository.beforeConditionalWrite = async (
                operation,
                namespace,
                key,
            ) => {
                if (
                    !replaced &&
                    operation === 'deleteIfRevision' &&
                    namespace === GROUP_TOPOLOGY_OVERRIDE_NAMESPACE
                ) {
                    replaced = true;
                    runtimeRepository.beforeConditionalWrite = undefined;
                    await runtimeRepository.upsertIfRevision(
                        namespace,
                        key,
                        JSON.stringify(refreshed),
                        refreshed.expiresAtEpochMs,
                        0,
                    );
                }
            };

            expect(await repository.findOverrideEntry(groupRef)).toMatchObject({
                entry: { revision: 1 },
                value: refreshed,
            });
            expect(await repository.findOverride(groupRef)).toEqual(refreshed);
        } finally {
            vi.useRealTimers();
        }
    });

    it('stores durable config and temporary overrides by full group ref', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);

        try {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new GroupTopologyConfigRepository(runtimeRepository);
            const groupRef = createGroupRef('workspace-1');
            const sameGroupOtherWorkspace = createGroupRef('workspace-2');
            const durable = {
                groupRef,
                config: {
                    topologyKind: 'tree' as const,
                    degreeLimit: 3,
                },
                version: 1,
                createdAtEpochMs: 1_000,
                updatedAtEpochMs: 1_000,
                updatedByPrincipalId: 'owner',
                requestId: 'request-1',
            };
            const otherWorkspaceDurable = {
                ...durable,
                groupRef: sameGroupOtherWorkspace,
                config: {
                    topologyKind: 'mesh' as const,
                    degreeLimit: 6,
                },
            };
            const override = {
                ...durable,
                config: {
                    topologyKind: 'star' as const,
                },
                version: 2,
                expiresAtEpochMs: 1_500,
            };

            await repository.commitConfig(durable, null);
            await repository.commitConfig(otherWorkspaceDurable, null);
            await repository.commitOverride(override, null);

            expect(await repository.findConfig(groupRef)).toEqual(durable);
            expect(await repository.findConfig(sameGroupOtherWorkspace))
                .toEqual(otherWorkspaceDurable);
            expect(await repository.findOverride(groupRef)).toEqual(override);
            expect(repository.configKey(groupRef)).not.toBe(
                repository.configKey(sameGroupOtherWorkspace),
            );

            vi.setSystemTime(1_501);
            expect(await repository.findOverride(groupRef)).toBeUndefined();

            await repository.deleteConfig(groupRef, 0);

            expect(await repository.findConfig(groupRef)).toBeUndefined();
            expect(await repository.findConfig(sameGroupOtherWorkspace))
                .toEqual(otherWorkspaceDurable);
            expect(runtimeRepository.data.has(
                `${GROUP_TOPOLOGY_CONFIG_NAMESPACE}::${repository.configKey(groupRef)}`,
            )).toBe(false);
            expect(runtimeRepository.data.has(
                `${GROUP_TOPOLOGY_OVERRIDE_NAMESPACE}::${repository.overrideKey(groupRef)}`,
            )).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});

function createGroupRef(workspaceId: string): GroupRef {
    return {
        applicationId: 'app-1',
        workspaceId,
        groupId: 'room-1',
    };
}

class PhysicalKeyAliasingRuntimeStateRepository
    extends FakeRuntimeStateRepository {
    aliasedNamespace?: string;

    override async findEntry(
        namespace: string,
        key: string,
    ): Promise<RuntimeStateEntry | undefined> {
        const entry = await super.findEntry(namespace, key);
        if (!entry || namespace !== this.aliasedNamespace) return entry;
        return { ...entry, key: `${entry.key}:alias=x` };
    }
}
