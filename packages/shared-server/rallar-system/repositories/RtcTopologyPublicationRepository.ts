import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    RuntimeStateRepositoryLike,
    RuntimeStateTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import { isRuntimeStateTransactionalRepositoryLike } from '../../runtime-state/RuntimeStateRepository.ts';
import { RuntimeStateJsonStore } from '../../runtime-state/RuntimeStateJsonStore.ts';

export const RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE = 'rtc-topology:publications';
export const RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE =
    'rtc-topology:publication-work-index';
export const DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS = 24 * 60 * 60 * 1_000;

export type RtcTopologyPublication = Readonly<{
    publicationId: string;
    workId: string;
    groupRef: GroupRef;
    sourceGroupStateRevision: number;
    overlayVersion: number;
    recipientSessionIds: readonly string[];
    message: ALMessage;
    createdAtEpochMs: number;
}>;

export type PutRtcTopologyPublicationResult = Readonly<{
    publication: RtcTopologyPublication;
    inserted: boolean;
}>;

export class RtcTopologyPublicationRepository extends RuntimeStateJsonStore {
    constructor(
        repository: RuntimeStateRepositoryLike,
        private readonly retentionMs: number =
            DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS,
        private readonly now: () => number = () => Date.now(),
    ) {
        super(repository);
    }

    async findPublication(
        publicationId: string,
    ): Promise<RtcTopologyPublication | undefined> {
        return await this.getValue<RtcTopologyPublication>(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            publicationId,
        );
    }

    async findPublicationForWork(
        workId: string,
    ): Promise<RtcTopologyPublication | undefined> {
        const publicationId = await this.getValue<string>(
            RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
            workId,
        );
        return publicationId
            ? await this.findPublication(publicationId)
            : undefined;
    }

    async putOrLoad(
        publication: RtcTopologyPublication,
    ): Promise<PutRtcTopologyPublicationResult> {
        if (!isRuntimeStateTransactionalRepositoryLike(this.repository)) {
            return await this.putOrLoadUnlocked(publication);
        }

        return await this.repository.begin(async (repository) => {
            await repository.lockKey(
                RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                publication.workId,
            );
            return await this.withRepository(repository)
                .putOrLoadUnlocked(publication);
        });
    }

    private async putOrLoadUnlocked(
        publication: RtcTopologyPublication,
    ): Promise<PutRtcTopologyPublicationResult> {
        const existingForWork = await this.findPublicationForWork(
            publication.workId,
        );
        if (existingForWork) {
            return { publication: existingForWork, inserted: false };
        }
        const existingForId = await this.findPublication(
            publication.publicationId,
        );
        if (existingForId) {
            await this.putValue(
                RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                publication.workId,
                existingForId.publicationId,
                this.now() + this.retentionMs,
            );
            return { publication: existingForId, inserted: false };
        }

        await this.putValue(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            publication.publicationId,
            publication,
            this.now() + this.retentionMs,
        );
        await this.putValue(
            RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
            publication.workId,
            publication.publicationId,
            this.now() + this.retentionMs,
        );
        return { publication, inserted: true };
    }

    private withRepository(
        repository: RuntimeStateTransactionalRepositoryLike,
    ): RtcTopologyPublicationRepository {
        return new RtcTopologyPublicationRepository(
            repository,
            this.retentionMs,
            this.now,
        );
    }
}

export function toRtcTopologyPublicationId(input: Readonly<{
    overlayId: string;
    cause: 'group-revision' | 'rtt-refresh';
    sourceGroupStateRevision: number;
    overlayVersion: number;
}>): string {
    return [
        input.overlayId,
        input.cause,
        input.sourceGroupStateRevision,
        input.overlayVersion,
    ].join(':');
}
