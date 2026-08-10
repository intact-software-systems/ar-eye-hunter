import { describe, expect, it, vi } from 'vitest';

import type { GroupRef } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state-storage-keys.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import {
  GROUP_TOPOLOGY_CONFIG_NAMESPACE,
  GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
} from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-runtime-namespaces.ts';

import { FakeRuntimeStateRepository } from '../../../fake-runtime-state-repository.ts';
import {
  createTopologyTestEffectiveConfig,
  createTopologyTestGroupRef,
} from './group-topology-config-persistence-test-fixtures.ts';

describe('group topology config repository reads and writes', () => {
  it('retains the required workspace in stored values', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const repository = new GroupTopologyConfigRepository(runtimeRepository);
    const groupRef: GroupRef = {
      applicationId: 'app-1',
      workspaceId: 'workspace-1',
      groupId: 'room-1',
    };
    const config = {
      groupRef,
      config: createTopologyTestEffectiveConfig('tree'),
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
      workspaceId: 'workspace-1',
      groupId: 'room-1',
    });
  });

  it('decodes canonical required-workspace sources consistently for list and page boundaries', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const repository = new GroupTopologyConfigRepository(runtimeRepository);
    const refs: readonly GroupRef[] = [
      { applicationId: 'app-1', workspaceId: 'workspace-empty', groupId: 'room-1' },
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
          config: createTopologyTestEffectiveConfig('tree'),
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
      refs
        .map((groupRef, index) => ({
          groupRef,
          target: 'config',
          version: index + 1,
        }))
        .sort((left, right) =>
          groupStateGroupStorageKey(left.groupRef).localeCompare(
            groupStateGroupStorageKey(right.groupRef),
          ),
        ),
    );
    const first = await repository.listGenerationSourcesPage('config', {
      limit: 2,
    });
    const second = await repository.listGenerationSourcesPage('config', {
      afterKey: first.at(-1)!.entry.key,
      limit: 3,
    });
    expect([...first, ...second].map(({ source }) => source.groupRef)).toEqual(
      (await repository.listGenerationSources('config')).map((source) => source.groupRef),
    );
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
  ])('decodes legacy $label rows with omitted requestId as null', async ({ namespace, target }) => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const repository = new GroupTopologyConfigRepository(runtimeRepository);
    const groupRef = createTopologyTestGroupRef('workspace-1');
    const legacy = {
      groupRef,
      config: createTopologyTestEffectiveConfig('tree'),
      version: 7,
      createdAtEpochMs: 1,
      updatedAtEpochMs: 2,
      updatedByPrincipalId: 'legacy-owner',
      ...(target === 'override' ? { expiresAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP } : {}),
    };
    const key =
      target === 'config' ? repository.configKey(groupRef) : repository.overrideKey(groupRef);
    await runtimeRepository.insertIfAbsent(
      namespace,
      key,
      JSON.stringify(legacy),
      NEVER_EXPIRE_AT_TIMESTAMP,
    );

    const decoded =
      target === 'config'
        ? await repository.findConfig(groupRef)
        : await repository.findOverride(groupRef);

    expect(decoded).toEqual({ ...legacy, requestId: null });
  });

  it('commits config and overrides only against the observed storage revision', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const repository = new GroupTopologyConfigRepository(runtimeRepository);
    const groupRef = createTopologyTestGroupRef('workspace-1');
    const first = {
      groupRef,
      config: createTopologyTestEffectiveConfig('tree'),
      version: 1,
      createdAtEpochMs: 1,
      updatedAtEpochMs: 1,
      updatedByPrincipalId: 'owner',
      requestId: 'config-1',
    };
    const second = {
      ...first,
      config: createTopologyTestEffectiveConfig('mesh'),
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

  it('stores durable config and temporary overrides by full group ref', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    try {
      const {
        runtimeRepository,
        repository,
        groupRef,
        sameGroupOtherWorkspace,
        durable,
        otherWorkspaceDurable,
        override,
      } = createFullGroupRefPersistenceScenario();

      await repository.commitConfig(durable, null);
      await repository.commitConfig(otherWorkspaceDurable, null);
      await repository.commitOverride(override, null);

      expect(await repository.findConfig(groupRef)).toEqual(durable);
      expect(await repository.findConfig(sameGroupOtherWorkspace)).toEqual(otherWorkspaceDurable);
      expect(await repository.findOverride(groupRef)).toEqual(override);
      expect(repository.configKey(groupRef)).not.toBe(
        repository.configKey(sameGroupOtherWorkspace),
      );

      vi.setSystemTime(1_501);
      expect(await repository.findOverride(groupRef)).toBeUndefined();

      await repository.deleteConfig(groupRef, 0);

      expect(await repository.findConfig(groupRef)).toBeUndefined();
      expect(await repository.findConfig(sameGroupOtherWorkspace)).toEqual(otherWorkspaceDurable);
      expect(
        runtimeRepository.data.has(
          `${GROUP_TOPOLOGY_CONFIG_NAMESPACE}::${repository.configKey(groupRef)}`,
        ),
      ).toBe(false);
      expect(
        runtimeRepository.data.has(
          `${GROUP_TOPOLOGY_OVERRIDE_NAMESPACE}::${repository.overrideKey(groupRef)}`,
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

function createFullGroupRefPersistenceScenario() {
  const runtimeRepository = new FakeRuntimeStateRepository();
  const repository = new GroupTopologyConfigRepository(runtimeRepository);
  const groupRef = createTopologyTestGroupRef('workspace-1');
  const sameGroupOtherWorkspace = createTopologyTestGroupRef('workspace-2');
  const durable = {
    groupRef,
    config: { ...createTopologyTestEffectiveConfig('tree'), degreeLimit: 3 },
    version: 1,
    createdAtEpochMs: 1_000,
    updatedAtEpochMs: 1_000,
    updatedByPrincipalId: 'owner',
    requestId: 'request-1',
  };
  const otherWorkspaceDurable = {
    ...durable,
    groupRef: sameGroupOtherWorkspace,
    config: { ...createTopologyTestEffectiveConfig('mesh'), degreeLimit: 6 },
  };
  const override = {
    ...durable,
    config: createTopologyTestEffectiveConfig('star'),
    version: 2,
    expiresAtEpochMs: 1_500,
  };
  return {
    runtimeRepository,
    repository,
    groupRef,
    sameGroupOtherWorkspace,
    durable,
    otherWorkspaceDurable,
    override,
  };
}
