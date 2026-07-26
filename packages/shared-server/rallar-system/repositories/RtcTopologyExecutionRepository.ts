import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type {
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import type { PSqlTransactionSql } from '../../postgres/PostgresSqlClient.ts';
import { PSqlRuntimeStateRepository } from '../../postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import {
    createRtcTopologyExecutionReceipt,
    DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS,
    hashRtcTopologyExecutionCommand,
    type RtcTopologyPublication,
    RtcTopologyPublicationRepository,
} from './RtcTopologyPublicationRepository.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from '../rtc-topology-errors.ts';
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
        const [snapshot, claimedPublication] = await Promise.all([
            snapshots.findSnapshotEntry(groupRef),
            workId === null
                ? Promise.resolve(undefined)
                : publications.findClaimedPublicationForWork(groupRef, workId),
        ]);
        if (
            claimedPublication &&
            claimedPublication.claim.value.acceptedStorageRevision !==
                snapshot?.entry.revision
        ) {
            throw new RtcTopologyRepositoryInvariantCorruptionError(
                claimedPublication.claim.entry.key,
                'RTC topology execution receipt storage revision differs from snapshot',
            );
        }
        return {
            snapshot: snapshot ?? null,
            publicationClaim: claimedPublication
                ? {
                    receipt: claimedPublication.claim.value,
                    publication: claimedPublication.publication,
                }
                : null,
        };
    }

    async writeTopologyMutation(
        transaction: PSqlTransactionSql,
        computed: Extract<
            RtcTopologyMutationComputed,
            { outcome: 'write' | 'publish-superseded' }
        >,
    ): Promise<'committed'> {
        const publicationWrite = requirePublicationWrite(computed);
        const runtime = new PSqlRuntimeStateRepository(transaction);
        const snapshots = new RtcTopologySnapshotRepository(runtime);
        const snapshotGuard = computed.outcome === 'write'
            ? computed.snapshotGuard
            : {
                expectedRevision: computed.currentGuard.expectedRevision,
                candidate: computed.currentGuard.current,
            };
        const guard = await snapshots.commitSnapshotGuard(
            snapshotGuard.candidate,
            snapshotGuard.expectedRevision,
        );
        if (guard.status === 'conflict') {
            throw new RuntimeStateWriteConflictError();
        }
        if (publicationWrite) {
            const publications = this.publications(runtime);
            const receipt = createRtcTopologyExecutionReceipt(
                publicationWrite.publication,
                {
                    commandHash: publicationWrite.commandHash,
                    attemptCount: publicationWrite.attemptCount,
                    acceptedStorageRevision: guard.storageRevision,
                },
            );
            const claimed = await publications.insertWorkClaim(
                receipt,
                publicationWrite.expireAtTimestamp,
            );
            if (!claimed) throw new RuntimeStateWriteConflictError();
            await publications.insertPublication(
                publicationWrite.publication,
                publicationWrite.expireAtTimestamp,
            );
        }
        return 'committed';
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
        const facts = read.publicationClaim
            ? {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null,
            } as const
            : {
                publicationExpireAtTimestamp: this.publicationExpireAtTimestamp(),
                commandHash: await hashRtcTopologyExecutionCommand(
                    input.publication,
                ),
                attemptCount: 1,
            } as const;
        const computed = computeTopologyMutation({
            read,
            candidate,
            publication: read.publicationClaim ? null : input.publication,
            facts,
        });
        validateTopologyMutation({
            read,
            candidate,
            publication: read.publicationClaim ? null : input.publication,
            facts,
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
        throw new TypeError(
            'RTC topology commits require an AppInbox or APP_OUTBOX transaction',
        );
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
    computed: Extract<
        RtcTopologyMutationComputed,
        { outcome: 'write' | 'publish-superseded' }
    >,
): Readonly<{
    publication: RtcTopologyPublication;
    expireAtTimestamp: number;
    commandHash: string;
    attemptCount: number;
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
    return {
        publication: computed.publication,
        expireAtTimestamp,
        commandHash: computed.commandHash,
        attemptCount: computed.attemptCount,
    };
}

function sameSnapshot(
    left: RallarOverlayTopologySnapshot | undefined,
    right: RallarOverlayTopologySnapshot | undefined,
): boolean {
    return left === right || rtcTopologySemanticEqual(left, right);
}
