import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import { FakeRuntimeStateRepository } from '../../../../fake-runtime-state-repository.ts';

export function createTopologyTestGroupRef(workspaceId: string): GroupRef {
    return {
        applicationId: 'app-1',
        workspaceId,
        groupId: 'room-1'
    };
}

export function createTopologyTestEffectiveConfig(topologyKind: 'auto' | 'star' | 'tree' | 'mesh') {
    return {
        topologyKind,
        degreeLimit: 5,
        treeMinSize: 5,
        meshMinSize: 16,
        meshParamK: 2
    };
}

export class PhysicalKeyAliasingRuntimeStateRepository extends FakeRuntimeStateRepository {
    aliasedNamespace?: string;

    override async findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined> {
        const entry = await super.findEntry(namespace, key);
        if (!entry || namespace !== this.aliasedNamespace) {
            return entry;
        }
        return { ...entry, key: `${entry.key}:alias=x` };
    }
}

export function createTopologyTestRepository(
    runtimeRepository = new FakeRuntimeStateRepository()
): GroupTopologyConfigRepository {
    return new GroupTopologyConfigRepository(runtimeRepository);
}
