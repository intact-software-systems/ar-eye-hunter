import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { readGroupVersion } from '@shared/api/group-client-views.ts';
import {
    findGroupStateSnapshotByRef,
    setGroupStateSnapshot,
    toGroupStateSnapshotRepositoryKey,
} from '@shared/repository/group-state-snapshots-repository.ts';
import { ObservableLoanedRepository } from '@shared/cache/ObservableLoanedRepository.ts';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import type { GroupStateRepository } from '../repositories/GroupStateRepository.ts';
import { isGroupSnapshotPresenceFresh, type RallarSnapshotPresenceClock, } from '../snapshot-presence.ts';

const DEFAULT_TTL_MS = 60_000;

export type GroupStateSnapshotReadThroughCacheOptions = Readonly<{
    groupsRepository: Pick<GroupStateRepository, 'readSnapshot'>;
    manager?: RepositoryManager;
    ttlMs?: number;
    now?: RallarSnapshotPresenceClock;
}>;

export type FindOrLoadGroupStateSnapshotOptions = Readonly<{
    minSnapshotVersion?: number;
}>;

export class GroupStateSnapshotNotFoundError extends Error {
    constructor(readonly ref: GroupRef) {
        super(
            `Group snapshot not found for ${ref.applicationId}/${ref.workspaceId ?? ''}/${ref.groupId}`,
        );
        this.name = 'GroupStateSnapshotNotFoundError';
    }
}

export class GroupStateSnapshotReadThroughCache {
    private readonly snapshots: ObservableLoanedRepository<string, GroupSnapshot>;

    constructor(
        private readonly options: GroupStateSnapshotReadThroughCacheOptions,
    ) {
        this.snapshots = new ObservableLoanedRepository<string, GroupSnapshot>(
            async (key) => {
                const ref = fromGroupStateSnapshotRepositoryKey(key);
                const snapshot = await options.groupsRepository.readSnapshot(ref);
                if (!snapshot) {
                    throw new GroupStateSnapshotNotFoundError(ref);
                }

                return snapshot;
            },
            {
                ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
                equals: (left, right) => readGroupVersion(left) === readGroupVersion(right),
            },
        );
        this.snapshots.onChangeDo((event) => {
            if (event.value) {
                setGroupStateSnapshot(event.value, this.options.manager);
            }
        });
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
        if (this.isUsable(latest, options.minSnapshotVersion)) {
            return latest;
        }

        const loaned = this.snapshots.read(key);
        if (this.isUsable(loaned, options.minSnapshotVersion)) {
            setGroupStateSnapshot(loaned, this.options.manager);
            return loaned;
        }

        return await this.loadByRef(ref, latest !== undefined || loaned !== undefined);
    }

    public async refreshByRef(ref: GroupRef): Promise<GroupSnapshot | undefined> {
        return await this.loadByRef(ref, true);
    }

    public async whenIdle(): Promise<void> {
        await this.snapshots.whenIdle();
    }

    private async loadByRef(
        ref: GroupRef,
        forceRefresh = false,
    ): Promise<GroupSnapshot | undefined> {
        try {
            const key = toGroupStateSnapshotRepositoryKey(ref);
            const snapshot = forceRefresh
                ? await this.snapshots.refresh(key)
                : await this.snapshots.get(key);
            await this.snapshots.whenIdle();
            return snapshot;
        } catch (error) {
            if (error instanceof GroupStateSnapshotNotFoundError) {
                return undefined;
            }

            throw error;
        }
    }

    private isUsable(
        snapshot: GroupSnapshot | undefined,
        minSnapshotVersion: number | undefined,
    ): snapshot is GroupSnapshot {
        return snapshot !== undefined &&
            this.isPresenceFresh(snapshot) &&
            (
                minSnapshotVersion === undefined ||
                readGroupVersion(snapshot) >= minSnapshotVersion
            );
    }

    private isPresenceFresh(
        snapshot: GroupSnapshot | undefined,
    ): snapshot is GroupSnapshot {
        return snapshot !== undefined &&
            isGroupSnapshotPresenceFresh(snapshot, this.now());
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

function fromGroupStateSnapshotRepositoryKey(key: string): GroupRef {
    const [applicationId, workspaceId, groupId] = JSON.parse(key) as [
        string,
        string,
        string,
    ];

    return {
        applicationId,
        workspaceId: workspaceId === '' ? undefined : workspaceId,
        groupId,
    };
}
