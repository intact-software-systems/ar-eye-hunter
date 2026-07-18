import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { RuntimeStateTransactionalRepositoryLike } from '../../runtime-state/RuntimeStateRepository.ts';
import {
    DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS,
    RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
    type RtcTopologyPublication,
    RtcTopologyPublicationRepository,
} from './RtcTopologyPublicationRepository.ts';
import {
    decideTopologySnapshot,
    RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
    RtcTopologySnapshotRepository,
} from './RtcTopologySnapshotRepository.ts';

export type RtcTopologyExecutionCommitResult =
    | Readonly<{
        status: 'committed' | 'loaded';
        snapshot: RallarOverlayTopologySnapshot;
        publication: RtcTopologyPublication;
    }>
    | Readonly<{
        status: 'retry';
        current?: RallarOverlayTopologySnapshot;
    }>
    | Readonly<{
        status: 'superseded';
        current: RallarOverlayTopologySnapshot;
    }>;

export class RtcTopologyExecutionRepository {
    constructor(
        private readonly repository: RuntimeStateTransactionalRepositoryLike,
        private readonly publicationRetentionMs: number =
            DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS,
        private readonly now: () => number = () => Date.now(),
    ) {}

    async findPublicationForWork(
        workId: string,
    ): Promise<RtcTopologyPublication | undefined> {
        return await this.publications(this.repository)
            .findPublicationForWork(workId);
    }

    async findSnapshot(
        groupRef: RtcTopologyPublication['groupRef'],
    ): Promise<RallarOverlayTopologySnapshot | undefined> {
        return await new RtcTopologySnapshotRepository(this.repository)
            .findSnapshot(groupRef);
    }

    async commit(input: Readonly<{
        expected?: RallarOverlayTopologySnapshot;
        candidate: RallarOverlayTopologySnapshot;
        publication: RtcTopologyPublication;
    }>): Promise<RtcTopologyExecutionCommitResult> {
        return await this.repository.begin(async (repository) => {
            const snapshots = new RtcTopologySnapshotRepository(repository);
            const publications = this.publications(repository);
            const lockKeys = [{
                namespace: RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
                key: snapshots.snapshotKey(input.candidate.groupRef),
            }, {
                namespace: RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                key: input.publication.workId,
            }].sort((left, right) =>
                `${left.namespace}:${left.key}`.localeCompare(
                    `${right.namespace}:${right.key}`,
                )
            );
            for (const lock of lockKeys) {
                await repository.lockKey(lock.namespace, lock.key);
            }

            const existing = await publications.findPublicationForWork(
                input.publication.workId,
            );
            const current = await snapshots.findSnapshot(
                input.candidate.groupRef,
            );
            if (existing) {
                return {
                    status: 'loaded',
                    snapshot: current ?? input.candidate,
                    publication: existing,
                };
            }
            if (!sameSnapshot(current, input.expected)) {
                return { status: 'retry', current };
            }

            const observation = decideTopologySnapshot(
                current,
                input.candidate,
            );
            if (observation === 'stale') {
                return { status: 'superseded', current: current! };
            }
            if (observation === 'inserted' || observation === 'advanced') {
                await snapshots.putSnapshot(input.candidate);
            }
            const persisted = await publications.putOrLoadWithinTransaction(
                input.publication,
            );
            return {
                status: persisted.inserted ? 'committed' : 'loaded',
                snapshot: input.candidate,
                publication: persisted.publication,
            };
        });
    }

    private publications(
        repository: RuntimeStateTransactionalRepositoryLike,
    ): RtcTopologyPublicationRepository {
        return new RtcTopologyPublicationRepository(
            repository,
            this.publicationRetentionMs,
            this.now,
        );
    }
}

function sameSnapshot(
    left: RallarOverlayTopologySnapshot | undefined,
    right: RallarOverlayTopologySnapshot | undefined,
): boolean {
    return left === right || JSON.stringify(left) === JSON.stringify(right);
}
