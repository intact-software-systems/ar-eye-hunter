import type { GroupRef } from '@shared/api/group-types.ts';
import {
    compareOverlayTopologyCausalTuple,
    type RallarOverlayTopologySnapshot,
} from '@shared/api/overlay-topology.ts';
import type {
    RuntimeStateRepositoryLike,
    RuntimeStateTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import { isRuntimeStateTransactionalRepositoryLike } from '../../runtime-state/RuntimeStateRepository.ts';
import { RuntimeStateJsonStore } from '../../runtime-state/RuntimeStateJsonStore.ts';

export const RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE = 'rtc-topology:snapshots';

export type RtcTopologySnapshotObservation =
    | 'inserted'
    | 'advanced'
    | 'duplicate'
    | 'stale';

export class RtcTopologySnapshotRevisionConflictError extends Error {
    constructor(readonly ref: GroupRef) {
        super(
            `RTC topology snapshot revision conflict: ${JSON.stringify(ref)}`,
        );
        this.name = 'RtcTopologySnapshotRevisionConflictError';
    }
}

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

    async observeSnapshot(
        snapshot: RallarOverlayTopologySnapshot,
        purgeAfterEpochMs: number = this.neverExpireAtTimestamp(),
    ): Promise<RtcTopologySnapshotObservation> {
        return await this.withSnapshotLock(snapshot.groupRef, async (repository) => {
            const current = await repository.findSnapshot(snapshot.groupRef);
            const decision = decideTopologySnapshot(current, snapshot);
            if (decision === 'inserted' || decision === 'advanced') {
                await repository.putSnapshot(snapshot, purgeAfterEpochMs);
            }
            return decision;
        });
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

function decideTopologySnapshot(
    current: RallarOverlayTopologySnapshot | undefined,
    incoming: RallarOverlayTopologySnapshot,
): RtcTopologySnapshotObservation {
    if (!current) {
        return 'inserted';
    }

    const tupleComparison = compareTopologyTuple(incoming, current);
    if (tupleComparison > 0) {
        return 'advanced';
    }
    if (tupleComparison < 0) {
        return 'stale';
    }
    if (JSON.stringify(current) === JSON.stringify(incoming)) {
        return 'duplicate';
    }
    throw new RtcTopologySnapshotRevisionConflictError(incoming.groupRef);
}

export function compareTopologyTuple(
    left: Pick<RallarOverlayTopologySnapshot, 'sourceGroupStateRevision' | 'version'>,
    right: Pick<RallarOverlayTopologySnapshot, 'sourceGroupStateRevision' | 'version'>,
): number {
    return compareOverlayTopologyCausalTuple(left, right);
}
