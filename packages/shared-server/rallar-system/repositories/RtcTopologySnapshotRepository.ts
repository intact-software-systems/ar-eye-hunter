import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type {
    RuntimeStateRepositoryLike,
    RuntimeStateTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import { isRuntimeStateTransactionalRepositoryLike } from '../../runtime-state/RuntimeStateRepository.ts';
import { RuntimeStateJsonStore } from '../../runtime-state/RuntimeStateJsonStore.ts';

export const RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE = 'rtc-topology:snapshots';

export class RtcTopologySnapshotRepository extends RuntimeStateJsonStore {
    constructor(repository: RuntimeStateRepositoryLike) {
        super(repository);
    }

    async findSnapshot(
        ref: GroupRef,
    ): Promise<RallarOverlayTopologySnapshot | undefined> {
        return await this.getValue<RallarOverlayTopologySnapshot>(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            this.snapshotKey(ref),
        );
    }

    async putSnapshot(
        snapshot: RallarOverlayTopologySnapshot,
        purgeAfterEpochMs: number = this.neverExpireAtTimestamp(),
    ): Promise<void> {
        await this.putValue(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            this.snapshotKey(snapshot.groupRef),
            snapshot,
            purgeAfterEpochMs,
        );
    }

    async removeSnapshot(ref: GroupRef): Promise<void> {
        await this.deleteValue(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            this.snapshotKey(ref),
        );
    }

    async withSnapshotLock<T>(
        ref: GroupRef,
        fn: (repository: RtcTopologySnapshotRepository) => Promise<T>,
    ): Promise<T> {
        if (!isRuntimeStateTransactionalRepositoryLike(this.repository)) {
            return await fn(this);
        }

        return await this.repository.begin(async (repository) => {
            await repository.lockKey(
                RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
                this.snapshotKey(ref),
            );
            return await fn(this.withRepository(repository));
        });
    }

    snapshotKey(ref: GroupRef): string {
        return [this.scopeKey(ref), this.idKey('group', ref.groupId)].join(':');
    }

    private withRepository(
        repository: RuntimeStateTransactionalRepositoryLike,
    ): RtcTopologySnapshotRepository {
        return new RtcTopologySnapshotRepository(repository);
    }
}
