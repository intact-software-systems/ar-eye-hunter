import { describe, expect, it } from 'vitest';

import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import {
    GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
    GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
    GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
    GROUP_TOPOLOGY_CONFIG_NAMESPACE,
    GROUP_TOPOLOGY_OVERRIDE_NAMESPACE
} from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-runtime-namespaces.ts';
import type { RuntimeStateEntryValue } from '@shared-server/runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { ReadBatchFakeRuntimeStateRepository } from '../../../../read-batch-fake-runtime-state-repository.ts';

const GROUP_REF: GroupRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1'
};

describe('group topology mutation exact read', () => {
    it('reads every requested topology slot in one ordered batch snapshot', async () => {
        const runtime = new ReadBatchFakeRuntimeStateRepository();
        const repository = new GroupTopologyConfigRepository(runtime);

        await expect(repository.readMutationExactEntries(GROUP_REF, 'request-1')).resolves.toEqual({
            status: 'stable',
            invariant: null,
            config: null,
            override: null,
            configGeneration: null,
            overrideGeneration: null,
            idempotency: null
        });
        expect(runtime.readBatchCalls).toEqual([
            [
                {
                    selectorId: 'topology-invariant',
                    kind: 'key',
                    namespace: GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
                    key: repository.invariantGenerationKey(GROUP_REF)
                },
                {
                    selectorId: 'topology-config',
                    kind: 'key',
                    namespace: GROUP_TOPOLOGY_CONFIG_NAMESPACE,
                    key: repository.configKey(GROUP_REF)
                },
                {
                    selectorId: 'topology-override',
                    kind: 'key',
                    namespace: GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
                    key: repository.overrideKey(GROUP_REF)
                },
                {
                    selectorId: 'topology-generation-config',
                    kind: 'key',
                    namespace: GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
                    key: repository.generationKey(GROUP_REF, 'config')
                },
                {
                    selectorId: 'topology-generation-override',
                    kind: 'key',
                    namespace: GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
                    key: repository.generationKey(GROUP_REF, 'override')
                },
                {
                    selectorId: 'topology-idempotency',
                    kind: 'key',
                    namespace: GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
                    key: repository.mutationKey(GROUP_REF, 'request-1')
                }
            ]
        ]);
    });

    it('omits the idempotency selector for query reads', async () => {
        const batchRuntime = new ReadBatchFakeRuntimeStateRepository();
        const batchRepository = new GroupTopologyConfigRepository(batchRuntime);

        await expect(batchRepository.readMutationExactEntries(GROUP_REF, null)).resolves.toMatchObject({
            status: 'stable',
            idempotency: null
        });
        expect(batchRuntime.readBatchCalls[0]?.map(({ selectorId }) => selectorId)).toEqual([
            'topology-invariant',
            'topology-config',
            'topology-override',
            'topology-generation-config',
            'topology-generation-override'
        ]);
    });

    it('reports equal-revision invariant content changes as concurrent change', async () => {
        const runtime = new ReadBatchFakeRuntimeStateRepository();
        const writer = new GroupTopologyConfigRepository(runtime);
        await writer.commitInvariantGeneration({ groupRef: GROUP_REF, version: 1 }, null);
        const reader = new EqualRevisionInvariantChangeRepository(runtime);

        await expect(reader.readMutationExactEntries(GROUP_REF, null)).resolves.toEqual({
            status: 'concurrent-change'
        });
    });
});

class EqualRevisionInvariantChangeRepository extends GroupTopologyConfigRepository {
    protected override async toLiveJsonEntryValue(
        namespace: string,
        entry: RuntimeStateEntry
    ): Promise<RuntimeStateEntryValue<JsonWireValue> | undefined> {
        const live = await super.toLiveJsonEntryValue(namespace, entry);
        if (live === undefined || namespace !== GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE) {
            return live;
        }
        return {
            entry: {
                ...live.entry,
                value: live.entry.value.replace('"version":1', '"version":2')
            },
            value: live.value
        };
    }
}
