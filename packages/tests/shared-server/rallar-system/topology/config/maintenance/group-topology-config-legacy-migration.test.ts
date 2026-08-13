import { describe, expect, it } from 'vitest';

import type { GroupRef } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { RuntimeStateRetryExhaustedError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state-storage-keys.ts';
import {
  backfillAllGroupTopologyConfigGenerations,
  backfillGroupTopologyConfigGenerationsForRef,
} from '@shared-server/rallar-system/topology/config/maintenance/backfill-group-topology-config-generations.ts';
import { migrateLegacyGroupTopologyConfigKeys } from '@shared-server/rallar-system/topology/config/maintenance/migrate-legacy-group-topology-config-keys.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import { GROUP_TOPOLOGY_CONFIG_NAMESPACE } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-runtime-namespaces.ts';

import { FakeRuntimeStateRepository } from '../../../../fake-runtime-state-repository.ts';
import { createTopologyTestEffectiveConfig } from '../persistence/group-topology-config-persistence-test-fixtures.ts';

describe('group topology config legacy migration', () => {
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
      config: createTopologyTestEffectiveConfig('tree'),
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

    await expect(
      migrateLegacyGroupTopologyConfigKeys(repository, {
        oldWritersStopped: true,
        sleep: () => Promise.resolve(),
      }),
    ).resolves.toBeUndefined();
    await expect(
      backfillAllGroupTopologyConfigGenerations(repository, {
        sleep: () => Promise.resolve(),
      }),
    ).resolves.toEqual({ scanned: 1, advanced: 1 });
    expect(
      await runtimeRepository.findEntry(GROUP_TOPOLOGY_CONFIG_NAMESPACE, legacyKey),
    ).toBeUndefined();
    expect(
      await runtimeRepository.findEntry(GROUP_TOPOLOGY_CONFIG_NAMESPACE, canonicalKey),
    ).toMatchObject({ value: JSON.stringify(legacy) });
    await expect(repository.findGenerationEntry(groupRef, 'config')).resolves.toMatchObject({
      value: { version: 7 },
    });
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
        config: createTopologyTestEffectiveConfig('tree'),
        version: 7,
        createdAtEpochMs: 1,
        updatedAtEpochMs: 1,
        updatedByPrincipalId: 'legacy-owner',
      }),
      NEVER_EXPIRE_AT_TIMESTAMP,
    );

    await expect(
      backfillGroupTopologyConfigGenerationsForRef(repository, groupRef, {
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toMatchObject({
      code: 'group-topology-config-legacy-key-migration-required',
    });
    await expect(
      backfillAllGroupTopologyConfigGenerations(repository, {
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toMatchObject({
      code: 'group-topology-config-repository-invariant-corruption',
    });
    expect(
      await runtimeRepository.findEntry(GROUP_TOPOLOGY_CONFIG_NAMESPACE, legacyKey),
    ).toBeDefined();
    expect(
      await runtimeRepository.findEntry(GROUP_TOPOLOGY_CONFIG_NAMESPACE, canonicalKey),
    ).toBeUndefined();
    expect(runtimeRepository.locks).toEqual([]);
  });

  it('does not claim an absent-workspace legacy source for the explicit sentinel', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const repository = new GroupTopologyConfigRepository(runtimeRepository);
    const absentRef: GroupRef = {
      applicationId: 'app-1',
      workspaceId: '',
      groupId: 'room-1',
    };
    const sentinelRef: GroupRef = { ...absentRef, workspaceId: '_' };
    const source = {
      groupRef: absentRef,
      config: createTopologyTestEffectiveConfig('tree'),
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

    await expect(
      backfillGroupTopologyConfigGenerationsForRef(repository, sentinelRef, {
        sleep: () => Promise.resolve(),
      }),
    ).resolves.toEqual({ scanned: 0, advanced: 0 });
    expect(
      await runtimeRepository.findEntry(
        GROUP_TOPOLOGY_CONFIG_NAMESPACE,
        groupStateGroupStorageKey(absentRef),
      ),
    ).toBeDefined();
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
      config: createTopologyTestEffectiveConfig('tree'),
      version: 7,
      createdAtEpochMs: 1,
      updatedAtEpochMs: 1,
      updatedByPrincipalId: 'legacy-owner',
    };
    const winner = {
      ...source,
      config: createTopologyTestEffectiveConfig('mesh'),
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

    await expect(
      migrateLegacyGroupTopologyConfigKeys(repository, {
        oldWritersStopped: true,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow('legacy key migration destination differs');
    expect(
      await runtimeRepository.findEntry(GROUP_TOPOLOGY_CONFIG_NAMESPACE, legacyKey),
    ).toBeDefined();
    expect(
      await runtimeRepository.findEntry(
        GROUP_TOPOLOGY_CONFIG_NAMESPACE,
        groupStateGroupStorageKey(groupRef),
      ),
    ).toMatchObject({ value: JSON.stringify(winner) });
  });

  it('removes a semantically identical normalized migration duplicate', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const repository = new GroupTopologyConfigRepository(runtimeRepository);
    const groupRef = createLegacySentinelGroupRef();
    const legacyKey = 'app=app-1:ws=_:group=room-1';
    const source = {
      groupRef,
      config: { ...createTopologyTestEffectiveConfig('tree'), degreeLimit: 4 },
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
        config: { ...createTopologyTestEffectiveConfig('tree'), degreeLimit: 4 },
        groupRef: {
          groupId: groupRef.groupId,
          workspaceId: groupRef.workspaceId,
          applicationId: groupRef.applicationId,
        },
      }),
      NEVER_EXPIRE_AT_TIMESTAMP,
    );

    await expect(
      migrateLegacyGroupTopologyConfigKeys(repository, {
        oldWritersStopped: true,
        sleep: () => Promise.resolve(),
      }),
    ).resolves.toBeUndefined();
    await expect(
      backfillAllGroupTopologyConfigGenerations(repository, {
        sleep: () => Promise.resolve(),
      }),
    ).resolves.toEqual({ scanned: 1, advanced: 1 });
    expect(
      await runtimeRepository.findEntry(GROUP_TOPOLOGY_CONFIG_NAMESPACE, legacyKey),
    ).toBeUndefined();
    await expect(repository.findConfig(groupRef)).resolves.toEqual({
      ...source,
      requestId: null,
    });
  });

  it('rolls back a migration destination when the observed source revision changes', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const repository = new GroupTopologyConfigRepository(runtimeRepository);
    const groupRef = createLegacySentinelGroupRef();
    const legacyKey = 'app=app-1:ws=_:group=room-1';
    const canonicalKey = groupStateGroupStorageKey(groupRef);
    const source = {
      groupRef,
      config: createTopologyTestEffectiveConfig('tree'),
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
      )
        return;
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

    await expect(
      migrateLegacyGroupTopologyConfigKeys(repository, {
        oldWritersStopped: true,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toBeInstanceOf(RuntimeStateRetryExhaustedError);
    expect(
      await runtimeRepository.findEntry(GROUP_TOPOLOGY_CONFIG_NAMESPACE, canonicalKey),
    ).toBeUndefined();
    expect(
      await runtimeRepository.findEntry(GROUP_TOPOLOGY_CONFIG_NAMESPACE, legacyKey),
    ).toMatchObject({ revision: 0 });
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
          config: createTopologyTestEffectiveConfig('tree'),
          version: index + 1,
          createdAtEpochMs: 1,
          updatedAtEpochMs: 1,
          updatedByPrincipalId: 'legacy-owner',
        }),
        NEVER_EXPIRE_AT_TIMESTAMP,
      );
    }

    await expect(
      migrateLegacyGroupTopologyConfigKeys(repository, {
        oldWritersStopped: true,
        sleep: () => Promise.resolve(),
      }),
    ).resolves.toBeUndefined();
    await expect(
      backfillAllGroupTopologyConfigGenerations(repository, {
        sleep: () => Promise.resolve(),
      }),
    ).resolves.toEqual({ scanned: 101, advanced: 101 });
    for (const groupRef of refs) {
      expect(
        await runtimeRepository.findEntry(
          GROUP_TOPOLOGY_CONFIG_NAMESPACE,
          `app=app-1:ws=_:group=${groupRef.groupId}`,
        ),
      ).toBeUndefined();
      expect(
        await runtimeRepository.findEntry(
          GROUP_TOPOLOGY_CONFIG_NAMESPACE,
          groupStateGroupStorageKey(groupRef),
        ),
      ).toBeDefined();
    }
    expect(runtimeRepository.locks).toEqual([]);
  });
});

function createLegacySentinelGroupRef(): GroupRef {
  return {
    applicationId: 'app-1',
    workspaceId: '_',
    groupId: 'room-1',
  };
}
