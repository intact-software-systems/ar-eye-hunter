import { describe, expect, it, vi } from 'vitest';

import {
    backfillAllGroupTopologyConfigGenerations,
    backfillGroupTopologyConfigGenerationsForRef
} from '@shared-server/rallar-system/topology/config/maintenance/backfill-group-topology-config-generations.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import {
    GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
    GROUP_TOPOLOGY_CONFIG_NAMESPACE,
    GROUP_TOPOLOGY_OVERRIDE_NAMESPACE
} from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-runtime-namespaces.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { FakeRuntimeStateRepository } from '../../../../fake-runtime-state-repository.ts';
import { createTopologyTestEffectiveConfig, createTopologyTestGroupRef } from './group-topology-config-persistence-test-fixtures.ts';

describe('group topology config generations', () => {
    it('conditionally advances a retained per-target generation record', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef = createTopologyTestGroupRef('workspace-1');
        const first = { groupRef, target: 'config' as const, version: 1 };
        const second = { ...first, version: 2 };

        expect(await repository.commitGeneration(first, null)).toEqual({
            status: 'accepted',
            storageRevision: 0
        });
        expect(await repository.commitGeneration(second, null)).toEqual({
            status: 'conflict'
        });
        expect(await repository.commitGeneration(second, 0)).toEqual({
            status: 'accepted',
            storageRevision: 1
        });
        expect(await repository.findGenerationEntry(groupRef, 'config')).toMatchObject({
            value: second,
            entry: { revision: 1 }
        });
        expect(
            runtimeRepository.data.has(
                `${GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE}::${repository.generationKey(groupRef, 'config')}`
            )
        ).toBe(true);
    });

    it('optimistically backfills config and expired override generations without deleting sources', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_000);
        try {
            const { runtimeRepository, repository, groupRef } = await seedLegacyGenerationSources();

            await expect(
                backfillAllGroupTopologyConfigGenerations(repository, {
                    sleep: () => Promise.resolve()
                })
            ).resolves.toEqual({ scanned: 2, advanced: 2 });
            await expect(repository.findGenerationEntry(groupRef, 'config')).resolves.toMatchObject({
                value: { version: 6 }
            });
            await expect(repository.findGenerationEntry(groupRef, 'override')).resolves.toMatchObject({
                value: { version: 7 }
            });
            expect(
                await runtimeRepository.findEntry(
                    GROUP_TOPOLOGY_CONFIG_NAMESPACE,
                    repository.configKey(groupRef)
                )
            ).toBeDefined();
            expect(
                await runtimeRepository.findEntry(
                    GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
                    repository.overrideKey(groupRef)
                )
            ).toBeDefined();
            expect(runtimeRepository.locks).toEqual([]);

            await expect(
                backfillAllGroupTopologyConfigGenerations(repository, {
                    sleep: () => Promise.resolve()
                })
            ).resolves.toEqual({ scanned: 2, advanced: 0 });
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('does not downgrade a generation that wins a backfill conflict', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef = createTopologyTestGroupRef('workspace-1');
        await runtimeRepository.insertIfAbsent(
            GROUP_TOPOLOGY_CONFIG_NAMESPACE,
            repository.configKey(groupRef),
            JSON.stringify({
                groupRef,
                config: createTopologyTestEffectiveConfig('tree'),
                version: 7,
                createdAtEpochMs: 1,
                updatedAtEpochMs: 1,
                updatedByPrincipalId: 'legacy-owner'
            }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );
        runtimeRepository.beforeConditionalWrite = async (operation, namespace, key) => {
            if (
                operation !== 'insertIfAbsent' ||
                namespace !== GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE
            ) {
                return;
            }
            runtimeRepository.beforeConditionalWrite = undefined;
            await runtimeRepository.insertIfAbsent(
                namespace,
                key,
                JSON.stringify({ groupRef, target: 'config', version: 8 }),
                NEVER_EXPIRE_AT_TIMESTAMP
            );
        };

        await expect(
            backfillGroupTopologyConfigGenerationsForRef(repository, groupRef, {
                sleep: () => Promise.resolve()
            })
        ).resolves.toEqual({ scanned: 1, advanced: 0 });
        await expect(repository.findGenerationEntry(groupRef, 'config')).resolves.toMatchObject({
            value: { version: 8 }
        });
        expect(runtimeRepository.locks).toEqual([]);
    });

    it('conditionally advances the retained aggregate invariant generation', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtimeRepository);
        const groupRef = createTopologyTestGroupRef('workspace-1');
        const first = { groupRef, version: 1 };
        const second = { groupRef, version: 2 };

        expect(await repository.commitInvariantGeneration(first, null)).toEqual({
            status: 'accepted',
            storageRevision: 0
        });
        expect(await repository.commitInvariantGeneration(second, null)).toEqual({
            status: 'conflict'
        });
        expect(await repository.commitInvariantGeneration(second, 0)).toEqual({
            status: 'accepted',
            storageRevision: 1
        });
        expect(await repository.findInvariantGenerationEntry(groupRef)).toMatchObject({
            value: second,
            entry: {
                key: repository.invariantGenerationKey(groupRef),
                revision: 1
            }
        });
    });

    it('keeps expired override reads observational before a guarded refresh', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_000);
        try {
            const runtimeRepository = new FakeRuntimeStateRepository();
            const repository = new GroupTopologyConfigRepository(runtimeRepository);
            const groupRef = createTopologyTestGroupRef('workspace-1');
            const stale = {
                groupRef,
                config: createTopologyTestEffectiveConfig('tree'),
                version: 1,
                createdAtEpochMs: 1,
                updatedAtEpochMs: 1,
                updatedByPrincipalId: 'owner',
                requestId: 'override-stale',
                expiresAtEpochMs: 1_000
            };
            const refreshed = {
                ...stale,
                config: createTopologyTestEffectiveConfig('mesh'),
                version: 2,
                updatedAtEpochMs: 2_000,
                requestId: 'override-refreshed',
                expiresAtEpochMs: 10_000
            };
            await repository.commitOverride(stale, null);
            let replaced = false;
            runtimeRepository.beforeConditionalWrite = async (operation, namespace, key) => {
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
                        0
                    );
                }
            };

            expect(await repository.findOverrideEntry(groupRef)).toBeUndefined();
            expect(replaced).toBe(false);
            await expect(repository.commitOverride(refreshed, 0)).resolves.toMatchObject({
                status: 'accepted',
                storageRevision: 1
            });
            expect(await repository.findOverrideEntry(groupRef)).toMatchObject({
                entry: { revision: 1 },
                value: refreshed
            });
            expect(await repository.findOverride(groupRef)).toEqual(refreshed);
        }
        finally {
            vi.useRealTimers();
        }
    });
});

async function seedLegacyGenerationSources() {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const repository = new GroupTopologyConfigRepository(runtimeRepository);
    const groupRef = createTopologyTestGroupRef('workspace-1');
    const legacyConfig = {
        groupRef,
        config: createTopologyTestEffectiveConfig('tree'),
        version: 6,
        createdAtEpochMs: 1,
        updatedAtEpochMs: 1,
        updatedByPrincipalId: 'legacy-owner'
    };
    const legacyOverride = {
        ...legacyConfig,
        version: 7,
        expiresAtEpochMs: 1_500
    };
    await runtimeRepository.insertIfAbsent(
        GROUP_TOPOLOGY_CONFIG_NAMESPACE,
        repository.configKey(groupRef),
        JSON.stringify(legacyConfig),
        NEVER_EXPIRE_AT_TIMESTAMP
    );
    await runtimeRepository.insertIfAbsent(
        GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
        repository.overrideKey(groupRef),
        JSON.stringify(legacyOverride),
        legacyOverride.expiresAtEpochMs
    );
    return { runtimeRepository, repository, groupRef };
}
