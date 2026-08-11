import type { ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';
import { DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import { readClientStateRevision, readClientVersion } from '@shared/api/group-client-views.ts';
import {
  findClientStateSnapshotByRef,
  fromClientStateSnapshotRepositoryKey,
  observeClientStateSnapshot,
  removeClientStateSnapshotIfUnchanged,
  toClientStateSnapshotRepositoryKey as toSharedClientStateSnapshotRepositoryKey,
} from '@shared/repository/client-state-snapshots-repository.ts';
import type { StateSnapshotObservation } from '@shared/repository/state-snapshot-revision.ts';
import { ObservableLoanedRepository } from '@shared/cache/ObservableLoanedRepository.ts';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import type { ClientStateRepository } from '../persistence/client-state-repository.ts';
import {
  isClientSnapshotPresenceFresh,
  type RallarSnapshotPresenceClock,
} from '../../snapshot-presence.ts';

const DEFAULT_TTL_MS = 60_000;

export type ClientStateSnapshotReadThroughCacheOptions = Readonly<{
  clientsRepository: Pick<ClientStateRepository, 'readSnapshot'>;
  manager?: RepositoryManager;
  ttlMs?: number;
  now?: RallarSnapshotPresenceClock;
}>;

export type FindOrLoadClientStateSnapshotOptions = Readonly<{
  minSnapshotVersion?: number;
  minStateRevision?: number;
}>;

export class ClientStateSnapshotNotFoundError extends Error {
  readonly ref: ClientPrincipalRef;

  constructor(ref: ClientPrincipalRef) {
    const workspaceId = ref.workspaceId ?? '';
    super(`Client snapshot not found for ${ref.applicationId}/${workspaceId}/${ref.principalId}`);
    this.ref = ref;
    this.name = 'ClientStateSnapshotNotFoundError';
  }
}

export class ClientStateSnapshotReadThroughCache {
  private readonly snapshots: ObservableLoanedRepository<string, ClientSnapshot>;

  private readonly options: ClientStateSnapshotReadThroughCacheOptions;

  constructor(options: ClientStateSnapshotReadThroughCacheOptions) {
    this.options = options;
    this.snapshots = new ObservableLoanedRepository<string, ClientSnapshot>(
      async (key) => {
        const ref = toClientPrincipalRef(key);
        const snapshot = await options.clientsRepository.readSnapshot(ref);
        if (!snapshot) {
          throw new ClientStateSnapshotNotFoundError(ref);
        }

        observeClientStateSnapshot(snapshot, options.manager);
        return snapshot;
      },
      {
        ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
        equals: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      },
    );
    this.snapshots.onChangeDo((event) => {
      if (event.value) {
        observeClientStateSnapshot(event.value, this.options.manager);
      }
    });
  }

  public peek(ref: ClientPrincipalRef): ClientSnapshot | undefined {
    return this.findByRef(ref);
  }

  public findByRef(ref: ClientPrincipalRef): ClientSnapshot | undefined {
    const latest = findClientStateSnapshotByRef(ref, this.options.manager);
    if (this.isPresenceFresh(latest)) {
      return latest;
    }

    const loaned = this.snapshots.read(toClientStateSnapshotRepositoryKey(ref));
    return this.isPresenceFresh(loaned) ? loaned : undefined;
  }

  public readLoadedSnapshots(): ClientSnapshot[] {
    return this.snapshots.readAllValues();
  }

  public async findOrLoadByRef(
    ref: ClientPrincipalRef,
    options: FindOrLoadClientStateSnapshotOptions = {},
  ): Promise<ClientSnapshot | undefined> {
    const key = toClientStateSnapshotRepositoryKey(ref);
    const latest = findClientStateSnapshotByRef(ref, this.options.manager);
    if (this.isUsable(latest, options)) {
      return latest;
    }

    const loaned = this.snapshots.read(key);
    if (this.isUsable(loaned, options)) {
      observeClientStateSnapshot(loaned, this.options.manager);
      return loaned;
    }

    const loaded = await this.loadByRef(ref, latest !== undefined || loaned !== undefined);
    return this.isUsable(loaded, options) ? loaded : undefined;
  }

  public async refreshByRef(ref: ClientPrincipalRef): Promise<ClientSnapshot | undefined> {
    return await this.loadByRef(ref, true);
  }

  public async whenIdle(): Promise<void> {
    await this.snapshots.whenIdle();
  }

  public evictIfUnchanged(
    ref: ClientPrincipalRef,
    expected: ClientSnapshot,
  ): boolean {
    const latestRemoved = removeClientStateSnapshotIfUnchanged(
      ref,
      expected,
      this.options.manager,
    );
    const loanedRemoved = this.snapshots.compareAndDelete(
      toClientStateSnapshotRepositoryKey(ref),
      expected,
    );
    return latestRemoved || loanedRemoved;
  }

  public observe(snapshot: ClientSnapshot): StateSnapshotObservation {
    return observeClientStateSnapshot(snapshot, this.options.manager);
  }

  private async loadByRef(
    ref: ClientPrincipalRef,
    forceRefresh = false,
  ): Promise<ClientSnapshot | undefined> {
    try {
      const key = toClientStateSnapshotRepositoryKey(ref);
      const snapshot = forceRefresh
        ? await this.snapshots.refresh(key)
        : await this.snapshots.get(key);
      await this.snapshots.whenIdle();
      return findClientStateSnapshotByRef(ref, this.options.manager) ?? snapshot;
    } catch (error) {
      if (error instanceof ClientStateSnapshotNotFoundError) {
        return undefined;
      }

      throw error;
    }
  }

  private isUsable(
    snapshot: ClientSnapshot | undefined,
    options: FindOrLoadClientStateSnapshotOptions,
  ): snapshot is ClientSnapshot {
    return (
      snapshot !== undefined &&
      this.isPresenceFresh(snapshot) &&
      (options.minSnapshotVersion === undefined ||
        readClientVersion(snapshot) >= options.minSnapshotVersion) &&
      (options.minStateRevision === undefined ||
        readClientStateRevision(snapshot) >= options.minStateRevision)
    );
  }

  private isPresenceFresh(snapshot: ClientSnapshot | undefined): snapshot is ClientSnapshot {
    return snapshot !== undefined && isClientSnapshotPresenceFresh(snapshot, this.now());
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export function createClientStateSnapshotReadThroughCache(
  options: ClientStateSnapshotReadThroughCacheOptions,
): ClientStateSnapshotReadThroughCache {
  return new ClientStateSnapshotReadThroughCache(options);
}

export function toClientStateSnapshotRepositoryKey(ref: ClientPrincipalRef): string {
  return toSharedClientStateSnapshotRepositoryKey(ref);
}

function toClientPrincipalRef(key: string): ClientPrincipalRef {
  const { applicationId, workspaceId, principalId } =
    fromClientStateSnapshotRepositoryKey(key);

  return {
    applicationId,
    workspaceId: workspaceId ?? DEFAULT_STATE_WORKSPACE_ID,
    principalId,
  };
}
