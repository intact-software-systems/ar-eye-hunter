import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type {
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import {
    DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS,
    type RtcTopologyPublication,
    RtcTopologyPublicationRepository,
} from './RtcTopologyPublicationRepository.ts';
import {
    RtcTopologySnapshotRepository,
} from './RtcTopologySnapshotRepository.ts';
import {
    computeTopologyMutation,
    type RtcTopologyMutationComputed,
    type RtcTopologyMutationRead,
    validateTopologyMutation,
} from '../services/rtc-topology-mutations.ts';
import { rtcTopologySemanticEqual } from '../rtc-topology-semantic-equality.ts';

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
        readonly runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike,
        private readonly publicationRetentionMs: number =
            DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS,
        private readonly now: () => number = () => Date.now(),
    ) {}

    async findPublicationForWork(
        groupRef: GroupRef,
        workId: string,
    ): Promise<RtcTopologyPublication | undefined>;
    async findPublicationForWork(
        workId: string,
    ): Promise<RtcTopologyPublication | undefined>;
    async findPublicationForWork(
        groupRefOrWorkId: GroupRef | string,
        maybeWorkId?: string,
    ): Promise<RtcTopologyPublication | undefined> {
        return typeof groupRefOrWorkId === 'string'
            ? await this.publications(this.runtimeRepository)
                .findPublicationForWork(groupRefOrWorkId)
            : await this.publications(this.runtimeRepository)
                .findPublicationForWork(groupRefOrWorkId, maybeWorkId!);
    }

    async findSnapshot(
        groupRef: GroupRef,
    ): Promise<RallarOverlayTopologySnapshot | undefined> {
        return await new RtcTopologySnapshotRepository(this.runtimeRepository)
            .findSnapshot(groupRef);
    }

    async readTopologyMutation(
        groupRef: GroupRef,
        workId: string | null,
    ): Promise<RtcTopologyMutationRead> {
        const snapshots = new RtcTopologySnapshotRepository(this.runtimeRepository);
        const publications = this.publications(this.runtimeRepository);
        const [snapshot, publication] = await Promise.all([
            snapshots.findSnapshotEntry(groupRef),
            workId === null
                ? Promise.resolve(undefined)
                : publications.findPublicationForWork(groupRef, workId),
        ]);
        return {
            snapshot: snapshot ?? null,
            publicationClaim: publication ? { publication } : null,
        };
    }

    async writeTopologyMutation(
        computed: Extract<RtcTopologyMutationComputed, { outcome: 'write' }>,
    ): Promise<'committed' | 'conflict'> {
        const publicationWrite = requirePublicationWrite(computed);
        try {
            await this.runtimeRepository.begin(async (transaction) => {
                const snapshots = new RtcTopologySnapshotRepository(transaction);
                const guard = await snapshots.commitSnapshotGuard(
                    computed.snapshotGuard.candidate,
                    computed.snapshotGuard.expectedRevision,
                );
                if (guard.status === 'conflict') {
                    throw new RuntimeStateWriteConflictError();
                }
                if (publicationWrite) {
                    const publications = this.publications(transaction);
                    const claimed = await publications.insertWorkClaim(
                        publicationWrite.publication,
                        publicationWrite.expireAtTimestamp,
                    );
                    if (!claimed) throw new RuntimeStateWriteConflictError();
                    await publications.insertPublication(
                        publicationWrite.publication,
                        publicationWrite.expireAtTimestamp,
                    );
                }
            });
            return 'committed';
        } catch (error) {
            if (error instanceof RuntimeStateWriteConflictError) return 'conflict';
            throw error;
        }
    }

    async commit(input: Readonly<{
        expected?: RallarOverlayTopologySnapshot;
        candidate: RallarOverlayTopologySnapshot;
        publication: RtcTopologyPublication;
    }>): Promise<RtcTopologyExecutionCommitResult> {
        const read = await this.readTopologyMutation(
            input.candidate.groupRef,
            input.publication.workId,
        );
        if (
            !read.publicationClaim &&
            !sameSnapshot(read.snapshot?.value, input.expected)
        ) {
            return { status: 'retry', current: read.snapshot?.value };
        }
        const candidate = read.publicationClaim ? null : input.candidate;
        const computed = computeTopologyMutation({
            read,
            candidate,
            publication: read.publicationClaim ? null : input.publication,
            facts: {
                publicationExpireAtTimestamp: read.publicationClaim
                    ? null
                    : this.publicationExpireAtTimestamp(),
            },
        });
        validateTopologyMutation({
            read,
            candidate,
            publication: read.publicationClaim ? null : input.publication,
            facts: {
                publicationExpireAtTimestamp: computed.outcome === 'write'
                    ? computed.publicationExpireAtTimestamp
                    : null,
            },
            computed,
        });
        if (computed.outcome === 'retry') {
            return { status: 'retry', current: read.snapshot?.value };
        }
        if (computed.outcome === 'loaded') {
            return {
                status: 'loaded',
                snapshot: computed.snapshot,
                publication: computed.publication,
            };
        }
        if (computed.outcome === 'superseded') {
            return { status: 'superseded', current: computed.current };
        }
        const written = await this.writeTopologyMutation(computed);
        if (written === 'conflict') {
            return {
                status: 'retry',
                current: await this.findSnapshot(input.candidate.groupRef),
            };
        }
        return {
            status: 'committed',
            snapshot: computed.snapshotGuard.candidate,
            publication: input.publication,
        };
    }

    publicationExpireAtTimestamp(): number {
        return this.now() + this.publicationRetentionMs;
    }

    private publications(
        repository: RuntimeStateOptimisticTransactionalRepositoryLike,
    ): RtcTopologyPublicationRepository {
        return new RtcTopologyPublicationRepository(
            repository,
            this.publicationRetentionMs,
            this.now,
        );
    }
}

function requirePublicationWrite(
    computed: Extract<RtcTopologyMutationComputed, { outcome: 'write' }>,
): Readonly<{
    publication: RtcTopologyPublication;
    expireAtTimestamp: number;
}> | null {
    if (computed.publication === null) {
        if (computed.publicationExpireAtTimestamp !== null) {
            throw new TypeError(
                'RTC topology publication expiry must be null without publication',
            );
        }
        return null;
    }
    const expireAtTimestamp = computed.publicationExpireAtTimestamp;
    if (
        !Number.isSafeInteger(expireAtTimestamp) ||
        expireAtTimestamp <= computed.publication.createdAtEpochMs
    ) {
        throw new TypeError('RTC topology publication expiry is invalid');
    }
    return { publication: computed.publication, expireAtTimestamp };
}

function sameSnapshot(
    left: RallarOverlayTopologySnapshot | undefined,
    right: RallarOverlayTopologySnapshot | undefined,
): boolean {
    return left === right || rtcTopologySemanticEqual(left, right);
}
