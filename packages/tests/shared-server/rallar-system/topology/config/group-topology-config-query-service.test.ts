import { describe, expect, it, vi } from 'vitest';

import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import { GroupTopologyConfigQueryService } from '@shared-server/rallar-system/topology/config/group-topology-config-query-service.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import { GroupTopologyManagementService } from '@shared-server/rallar-system/topology/group-topology-management-service.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { FakeRuntimeStateRepository } from '../../../fake-runtime-state-repository.ts';
import { createTopologyTestEffectiveConfig, createTopologyTestGroupRef } from './persistence/group-topology-config-persistence-test-fixtures.ts';

const GROUP_REF = createTopologyTestGroupRef('workspace-1');

describe('GroupTopologyConfigQueryService', () => {
    it('reads generation readiness before the exact durable config pair', async () => {
        const phases: string[] = [];
        const repository = new GroupTopologyConfigRepository(new FakeRuntimeStateRepository());
        const durable = storedConfig('tree');
        const temporary = { ...storedConfig('mesh'), expiresAtEpochMs: 10_000 };
        repository.readMutationExactEntries = vi.fn(async () => {
            phases.push('read');
            return {
                status: 'stable',
                config: { entry: { revision: 1 }, value: durable },
                override: { entry: { revision: 2 }, value: temporary }
            } as never;
        });
        const query = createQuery({
            repository,
            ensure: async () => {
                phases.push('ready');
            }
        });

        await expect(query.readConfig(GROUP_REF)).resolves.toMatchObject({
            durable,
            temporary,
            effective: { topologyKind: 'mesh' }
        });
        expect(phases).toEqual(['ready', 'read']);
    });

    it('uses server defaults without readiness or persistence in local mode', async () => {
        const ensure = vi.fn();
        const query = createQuery({ repository: undefined, ensure });

        await expect(query.readConfig(GROUP_REF)).resolves.toMatchObject({
            effective: {
                topologyKind: 'tree',
                degreeLimit: 7
            },
            durable: null,
            temporary: null
        });
        expect(ensure).not.toHaveBeenCalled();
    });

    it('prefers the persisted topology snapshot and preserves the complete scoped view', async () => {
        const persistedSnapshot = { overlayId: 'persisted-overlay' } as never;
        const localSnapshot = { overlayId: 'local-overlay' } as never;
        const group = { group: GROUP_REF } as GroupSnapshot;
        const query = new GroupTopologyConfigQueryService({
            findGroupSnapshotByRef: async () => group,
            readLocalTopologySnapshot: () => localSnapshot,
            readPersistedTopologySnapshot: async () => persistedSnapshot,
            readiness: { ensure: async () => undefined },
            serverDefaults: { topologyKind: 'tree', degreeLimit: 7 }
        });

        await expect(query.readTopologyView(GROUP_REF)).resolves.toMatchObject({
            groupRef: GROUP_REF,
            snapshot: persistedSnapshot,
            pending: null
        });
    });

    it('rejects direct config writes that bypass AppInbox execution', async () => {
        const service = new GroupTopologyManagementService({
            findGroupSnapshotByRef: async () => undefined,
            topologyService: new RallarRtcTopologyService({ now: () => 20_000 }),
            processRttReader: () => [],
            now: () => 20_000
        });

        await expect(
            service.putConfig({
                groupRef: GROUP_REF,
                config: { topologyKind: 'mesh' },
                updatedByPrincipalId: 'owner',
                requestId: 'bypass-put'
            })
        ).rejects.toThrow(/AppInbox execution/);
        await expect(
            service.deleteConfig({
                groupRef: GROUP_REF,
                updatedByPrincipalId: 'owner',
                requestId: 'bypass-delete'
            })
        ).rejects.toThrow(/AppInbox execution/);
    });
});

function createQuery(input: {
    repository: GroupTopologyConfigRepository | undefined;
    ensure: () => Promise<void>;
}): GroupTopologyConfigQueryService {
    return new GroupTopologyConfigQueryService({
        findGroupSnapshotByRef: async () => undefined,
        readLocalTopologySnapshot: () => undefined,
        configRepository: input.repository,
        readiness: { ensure: input.ensure },
        serverDefaults: { topologyKind: 'tree', degreeLimit: 7 }
    });
}

function storedConfig(topologyKind: 'tree' | 'mesh') {
    return {
        groupRef: GROUP_REF,
        config: createTopologyTestEffectiveConfig(topologyKind),
        version: 1,
        createdAtEpochMs: 1,
        updatedAtEpochMs: 1,
        updatedByPrincipalId: 'owner',
        requestId: `${topologyKind}-request`
    };
}
