import { describe, expect, it } from 'vitest';

import type { GroupRef } from '@shared/api/group-types.ts';
import {
  GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
  GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
  GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
  GROUP_TOPOLOGY_CONFIG_NAMESPACE,
  GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
  GroupTopologyConfigRepository,
} from '@shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';
import { ReadBatchFakeRuntimeStateRepository } from './read-batch-fake-runtime-state-repository.ts';

const GROUP_REF: GroupRef = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
  groupId: 'room-1',
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
      idempotency: null,
    });
    expect(runtime.readBatchCalls).toEqual([
      [
        {
          selectorId: 'topology-invariant',
          kind: 'key',
          namespace: GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE,
          key: repository.invariantGenerationKey(GROUP_REF),
        },
        {
          selectorId: 'topology-config',
          kind: 'key',
          namespace: GROUP_TOPOLOGY_CONFIG_NAMESPACE,
          key: repository.configKey(GROUP_REF),
        },
        {
          selectorId: 'topology-override',
          kind: 'key',
          namespace: GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
          key: repository.overrideKey(GROUP_REF),
        },
        {
          selectorId: 'topology-generation-config',
          kind: 'key',
          namespace: GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
          key: repository.generationKey(GROUP_REF, 'config'),
        },
        {
          selectorId: 'topology-generation-override',
          kind: 'key',
          namespace: GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE,
          key: repository.generationKey(GROUP_REF, 'override'),
        },
        {
          selectorId: 'topology-idempotency',
          kind: 'key',
          namespace: GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
          key: repository.mutationKey(GROUP_REF, 'request-1'),
        },
      ],
    ]);
  });

  it('omits the idempotency selector for query reads and falls back without batch support', async () => {
    const batchRuntime = new ReadBatchFakeRuntimeStateRepository();
    const batchRepository = new GroupTopologyConfigRepository(batchRuntime);
    const fallbackRepository = new GroupTopologyConfigRepository(new FakeRuntimeStateRepository());

    await expect(batchRepository.readMutationExactEntries(GROUP_REF, null)).resolves.toMatchObject({
      status: 'stable',
      idempotency: null,
    });
    expect(batchRuntime.readBatchCalls[0]?.map(({ selectorId }) => selectorId)).toEqual([
      'topology-invariant',
      'topology-config',
      'topology-override',
      'topology-generation-config',
      'topology-generation-override',
    ]);
    await expect(
      fallbackRepository.readMutationExactEntries(GROUP_REF, 'request-1'),
    ).resolves.toEqual({ status: 'fallback' });
  });
});
