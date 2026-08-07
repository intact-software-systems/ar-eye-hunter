import type { GroupRef, GroupSnapshot, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import { DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import {
  compareGroupCausalRevision,
  readGroupCausalRevision,
  readGroupStateRevision,
  readGroupVersion,
} from '@shared/api/group-client-views.ts';
import {
  findGroupStateSnapshotByRef,
  fromGroupStateSnapshotRepositoryKey,
  observeGroupStateSnapshot,
  removeGroupStateSnapshotIfUnchanged,
  toGroupStateSnapshotRepositoryKey,
} from '@shared/repository/group-state-snapshots-repository.ts';
import type { StateSnapshotObservation } from '@shared/repository/state-snapshot-revision.ts';
import { ObservableLoanedRepository } from '@shared/cache/ObservableLoanedRepository.ts';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import type { GroupStateRepository } from '../persistence/group-state-repository.ts';
import {
  isGroupSnapshotPresenceFresh,
  type RallarSnapshotPresenceClock,
} from '../../snapshot-presence.ts';

const DEFAULT_TTL_MS = 60_000;

export type GroupStateSnapshotReadThroughCacheOptions = Readonly<{
  groupsRepository: Pick<GroupStateRepository, 'readSnapshot'>;
  manager?: RepositoryManager;
  ttlMs?: number;
  now?: RallarSnapshotPresenceClock;
}>;

export type FindOrLoadGroupStateSnapshotOptions = Readonly<{
  minSnapshotVersion?: number;
  /** Authoritative lower bound. Prefer this over minStateRevision. */
  minCausalRevision?: GroupStateCausalRevision;
  /** Compatibility projection only. */
  minStateRevision?: number;
}>;

export class GroupStateSnapshotNotFoundError extends Error {
  constructor(readonly ref: GroupRef) {
    const identity = [ref.applicationId, ref.workspaceId ?? '', ref.groupId].join('/');
    super(`Group snapshot not found for ${identity}`);
    this.name = 'GroupStateSnapshotNotFoundError';
  }
}

export class GroupStateSnapshotReadThroughCache {
  private readonly snapshots: ObservableLoanedRepository<string, GroupSnapshot>;

  constructor(private readonly options: GroupStateSnapshotReadThroughCacheOptions) {
    this.snapshots = new ObservableLoanedRepository<string, GroupSnapshot>(
      async (key) => {
        const ref = toGroupRef(key);
        const snapshot = await options.groupsRepository.readSnapshot(ref);
        if (!snapshot) {
          throw new GroupStateSnapshotNotFoundError(ref);
        }

        observeGroupStateSnapshot(snapshot, options.manager);
        return snapshot;
      },
      {
        ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
        equals: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      },
    );
    this.snapshots.onChangeDo((event) => {
      if (event.value) {
        observeGroupStateSnapshot(event.value, this.options.manager);
      }
    });
  }

  public peek(ref: GroupRef): GroupSnapshot | undefined {
    return this.findByRef(ref);
  }

  public findByRef(ref: GroupRef): GroupSnapshot | undefined {
    const latest = findGroupStateSnapshotByRef(ref, this.options.manager);
    if (this.isPresenceFresh(latest)) {
      return latest;
    }

    const loaned = this.snapshots.read(toGroupStateSnapshotRepositoryKey(ref));
    return this.isPresenceFresh(loaned) ? loaned : undefined;
  }

  public async findOrLoadByRef(
    ref: GroupRef,
    options: FindOrLoadGroupStateSnapshotOptions = {},
  ): Promise<GroupSnapshot | undefined> {
    const key = toGroupStateSnapshotRepositoryKey(ref);
    const latest = findGroupStateSnapshotByRef(ref, this.options.manager);
    if (this.isUsable(latest, options)) {
      return latest;
    }

    const loaned = this.snapshots.read(key);
    if (this.isUsable(loaned, options)) {
      observeGroupStateSnapshot(loaned, this.options.manager);
      return loaned;
    }

    const loaded = await this.loadByRef(ref, latest !== undefined || loaned !== undefined);
    return this.isUsable(loaded, options) ? loaded : undefined;
  }

  public async refreshByRef(ref: GroupRef): Promise<GroupSnapshot | undefined> {
    return await this.loadByRef(ref, true);
  }

  public async whenIdle(): Promise<void> {
    await this.snapshots.whenIdle();
  }

  public evictIfUnchanged(
    ref: GroupRef,
    expected: GroupSnapshot,
  ): boolean {
    const latestRemoved = removeGroupStateSnapshotIfUnchanged(
      ref,
      expected,
      this.options.manager,
    );
    const loanedRemoved = this.snapshots.compareAndDelete(
      toGroupStateSnapshotRepositoryKey(ref),
      expected,
    );
    return latestRemoved || loanedRemoved;
  }

  public observe(snapshot: GroupSnapshot): StateSnapshotObservation {
    return observeGroupStateSnapshot(snapshot, this.options.manager);
  }

  private async loadByRef(ref: GroupRef, forceRefresh = false): Promise<GroupSnapshot | undefined> {
    try {
      const key = toGroupStateSnapshotRepositoryKey(ref);
      const snapshot = forceRefresh
        ? await this.snapshots.refresh(key)
        : await this.snapshots.get(key);
      await this.snapshots.whenIdle();
      return findGroupStateSnapshotByRef(ref, this.options.manager) ?? snapshot;
    } catch (error) {
      if (error instanceof GroupStateSnapshotNotFoundError) {
        return undefined;
      }

      throw error;
    }
  }

  private isUsable(
    snapshot: GroupSnapshot | undefined,
    options: FindOrLoadGroupStateSnapshotOptions,
  ): snapshot is GroupSnapshot {
    return (
      snapshot !== undefined &&
      this.isPresenceFresh(snapshot) &&
      (options.minSnapshotVersion === undefined ||
        readGroupVersion(snapshot) >= options.minSnapshotVersion) &&
      (options.minCausalRevision === undefined ||
        ['equal', 'dominates'].includes(
          compareGroupCausalRevision(readGroupCausalRevision(snapshot), options.minCausalRevision),
        )) &&
      (options.minStateRevision === undefined ||
        readGroupStateRevision(snapshot) >= options.minStateRevision)
    );
  }

  private isPresenceFresh(snapshot: GroupSnapshot | undefined): snapshot is GroupSnapshot {
    return snapshot !== undefined && isGroupSnapshotPresenceFresh(snapshot, this.now());
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export function createGroupStateSnapshotReadThroughCache(
  options: GroupStateSnapshotReadThroughCacheOptions,
): GroupStateSnapshotReadThroughCache {
  return new GroupStateSnapshotReadThroughCache(options);
}

function toGroupRef(key: string): GroupRef {
  const { applicationId, workspaceId, groupId } =
    fromGroupStateSnapshotRepositoryKey(key);

  return {
    applicationId,
    workspaceId: workspaceId ?? DEFAULT_STATE_WORKSPACE_ID,
    groupId,
  };
}
