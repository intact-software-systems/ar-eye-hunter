import { describe, expect, it, vi } from 'vitest';

import { GroupTopologyConfigQueryService } from '@shared-server/rallar-system/topology/config/group-topology-config-query-service.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import { createGroupTopologyRuntimeOwners } from '@shared-server/rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createTopologyTestEffectiveConfig, createTopologyTestGroupRef } from './persistence/group-topology-config-persistence-test-fixtures.ts';

const GROUP_REF = createTopologyTestGroupRef('workspace-1');

describe('GroupTopologyConfigQueryService', () => {
    it('reads the exact durable config pair', async () => {
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
        const query = createQuery(repository);

        await expect(query.readConfig(GROUP_REF)).resolves.toMatchObject({
            durable,
            temporary,
            effective: { topologyKind: 'mesh' }
        });
        expect(phases).toEqual(['read']);
    });

    it('uses server defaults without persistence in local mode', async () => {
        const query = createQuery(undefined);

        await expect(query.readConfig(GROUP_REF)).resolves.toMatchObject({
            effective: {
                topologyKind: 'tree',
                degreeLimit: 7
            },
            durable: null,
            temporary: null
        });
    });

    it('prefers the persisted topology snapshot and preserves the complete scoped view', async () => {
        const persistedSnapshot = { overlayId: 'persisted-overlay' } as never;
        const localSnapshot = { overlayId: 'local-overlay' } as never;
        const group = { group: GROUP_REF } as GroupSnapshot;
        const query = new GroupTopologyConfigQueryService({
            findGroupSnapshotByRef: async () => group,
            readLocalTopologySnapshot: () => localSnapshot,
            readPersistedTopologySnapshot: async () => persistedSnapshot,
            serverDefaults: { topologyKind: 'tree', degreeLimit: 7 }
        });

        await expect(query.readTopologyView(GROUP_REF)).resolves.toMatchObject({
            groupRef: GROUP_REF,
            snapshot: persistedSnapshot,
            pending: null
        });
    });

    it('does not expose direct config writes outside AppInbox execution', () => {
        const service = createGroupTopologyRuntimeOwners({
            findGroupSnapshotByRef: async () => undefined,
            readCurrentGroupSnapshot: async () => undefined,
            readRttMeasurements: () => [],
            topologyService: new RallarRtcTopologyService({ now: () => 20_000 })
        });

        expect('putConfig' in service).toBe(false);
        expect('deleteConfig' in service).toBe(false);
    });
});

function createQuery(
    repository: GroupTopologyConfigRepository | undefined
): GroupTopologyConfigQueryService {
    return new GroupTopologyConfigQueryService({
        findGroupSnapshotByRef: async () => undefined,
        readLocalTopologySnapshot: () => undefined,
        configRepository: repository,
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
