import { describe, expect, it } from 'vitest';

import type { GroupRef } from '@shared/api/group-types.ts';
import { GroupTopologyConfigGenerationReadiness } from '@shared-server/rallar-system/topology/config/maintenance/group-topology-config-generation-readiness.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';

import { FakeRuntimeStateRepository } from '../../../../fake-runtime-state-repository.ts';

const FIRST_GROUP: GroupRef = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
  groupId: 'group-1',
};
const SECOND_GROUP: GroupRef = {
  ...FIRST_GROUP,
  groupId: 'group-2',
};

describe('GroupTopologyConfigGenerationReadiness', () => {
  it('shares one in-flight backfill for the complete scoped group identity', async () => {
    const repository = new ObservedTopologyConfigRepository();
    const readiness = new GroupTopologyConfigGenerationReadiness(repository);

    await Promise.all([readiness.ensure(FIRST_GROUP), readiness.ensure(FIRST_GROUP)]);

    expect(repository.generationSourceReads).toEqual([
      `${scopedGroupKey(FIRST_GROUP)}:config`,
      `${scopedGroupKey(FIRST_GROUP)}:override`,
    ]);
  });

  it('keeps independently scoped group backfills independent', async () => {
    const repository = new ObservedTopologyConfigRepository();
    const readiness = new GroupTopologyConfigGenerationReadiness(repository);

    await Promise.all([readiness.ensure(FIRST_GROUP), readiness.ensure(SECOND_GROUP)]);

    expect(new Set(repository.generationSourceReads)).toEqual(
      new Set([
        `${scopedGroupKey(FIRST_GROUP)}:config`,
        `${scopedGroupKey(FIRST_GROUP)}:override`,
        `${scopedGroupKey(SECOND_GROUP)}:config`,
        `${scopedGroupKey(SECOND_GROUP)}:override`,
      ]),
    );
  });

  it('evicts a failed promise and retries the complete backfill on the next call', async () => {
    const repository = new ObservedTopologyConfigRepository();
    repository.failNextLegacyRead = true;
    const readiness = new GroupTopologyConfigGenerationReadiness(repository);

    await expect(readiness.ensure(FIRST_GROUP)).rejects.toThrow('readiness failure');
    await expect(readiness.ensure(FIRST_GROUP)).resolves.toBeUndefined();

    expect(repository.legacySourceReads).toBe(3);
    expect(repository.generationSourceReads).toHaveLength(2);
  });

  it('returns immediately when no persistence repository is configured', async () => {
    const readiness = new GroupTopologyConfigGenerationReadiness(undefined);

    await expect(readiness.ensure(FIRST_GROUP)).resolves.toBeUndefined();
  });
});

class ObservedTopologyConfigRepository extends GroupTopologyConfigRepository {
  readonly generationSourceReads: string[] = [];
  legacySourceReads = 0;
  failNextLegacyRead = false;

  constructor() {
    super(new FakeRuntimeStateRepository());
  }

  override async findGenerationSource(
    groupRef: GroupRef,
    target: 'config' | 'override',
  ): Promise<undefined> {
    this.generationSourceReads.push(`${scopedGroupKey(groupRef)}:${target}`);
    return undefined;
  }

  override async findLegacyKeyMigrationSource(
    groupRef: GroupRef,
    target: 'config' | 'override',
  ): Promise<undefined> {
    void groupRef;
    void target;
    this.legacySourceReads += 1;
    if (this.failNextLegacyRead) {
      this.failNextLegacyRead = false;
      throw new Error('readiness failure');
    }
    return undefined;
  }
}

function scopedGroupKey(groupRef: GroupRef): string {
  return [groupRef.applicationId, groupRef.workspaceId, groupRef.groupId].join('/');
}
