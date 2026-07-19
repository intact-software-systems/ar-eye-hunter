import { describe, expect, it, vi } from 'vitest';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    GROUP_TOPOLOGY_CONFIG_NAMESPACE,
    GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
    GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
    GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
    GroupTopologyConfigRepository,
} from '@shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('group topology config repository', () => {
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
                ? { expiresAtEpochMs: Number.MAX_SAFE_INTEGER }
                : {}),
        };
        const key = target === 'config'
            ? repository.configKey(groupRef)
            : repository.overrideKey(groupRef);
        await runtimeRepository.insertIfAbsent(
            namespace,
            key,
            JSON.stringify(legacy),
            Number.MAX_SAFE_INTEGER,
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
            Number.MAX_SAFE_INTEGER,
        );

        await expect(repository.findConfig(groupRef))
            .rejects.toThrow('Stored topology config fields are invalid');
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
                    outboxId: null,
                },
                result: { kind: 'delete', deleted: false },
            }),
            Number.MAX_SAFE_INTEGER,
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
                    outboxId: null,
                    ...receipt,
                },
                result: { kind: 'delete', deleted: false },
            }),
            Number.MAX_SAFE_INTEGER,
        );

        await expect(repository.findMutationRecord(groupRef, requestId))
            .rejects.toThrow(message);
    });

    it.each([
        {
            label: 'accepted config with another requestId',
            receipt: {},
            resultRequestId: 'different-request',
            message: 'accepted result requestId differs from record',
        },
        {
            label: 'put result paired with a no-op receipt',
            receipt: { outcome: 'no-op', outboxId: null },
            resultRequestId: 'expected-request',
            message: 'accepted result outcome differs from receipt',
        },
    ])('rejects persisted $label', async ({ receipt, resultRequestId, message }) => {
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
                    outboxId: 'state-mutation-valid-shape',
                    ...receipt,
                },
                result: {
                    kind: 'config',
                    config: {
                        groupRef,
                        config: { topologyKind: 'tree' },
                        version: 1,
                        createdAtEpochMs: 1,
                        updatedAtEpochMs: 1,
                        updatedByPrincipalId: 'owner',
                        requestId: resultRequestId,
                    },
                },
            }),
            Number.MAX_SAFE_INTEGER,
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
