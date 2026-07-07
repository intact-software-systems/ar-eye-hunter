import { describe, expect, it, vi } from 'vitest';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    GROUP_TOPOLOGY_CONFIG_NAMESPACE,
    GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
    GroupTopologyConfigRepository,
} from '@shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('group topology config repository', () => {
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

            await repository.putConfig(durable);
            await repository.putConfig(otherWorkspaceDurable);
            await repository.putOverride(override, override.expiresAtEpochMs);

            expect(await repository.findConfig(groupRef)).toEqual(durable);
            expect(await repository.findConfig(sameGroupOtherWorkspace))
                .toEqual(otherWorkspaceDurable);
            expect(await repository.findOverride(groupRef)).toEqual(override);
            expect(repository.configKey(groupRef)).not.toBe(
                repository.configKey(sameGroupOtherWorkspace),
            );

            vi.setSystemTime(1_501);
            expect(await repository.findOverride(groupRef)).toBeUndefined();

            await repository.deleteConfig(groupRef);

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
