import {
    RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
    RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE
} from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository-contracts.ts';
import { RtcTopologyPublicationRepository } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository.ts';
import type { RtcTopologyPublication } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import { PSqlRuntimeStateRepository } from '../../../runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import type { RtcTopologyMutationComputed, RtcTopologyMutationRead } from '../mutation/rtc-topology-mutations.ts';
import { RTC_TOPOLOGY_REPLAY_RETENTION_MS } from '../replay/consumer/rtc-topology-replay-policy.ts';
import {
    RTC_TOPOLOGY_INPUT_FINGERPRINTS_NAMESPACE,
    RtcTopologyInputFingerprintRepository,
    type RtcTopologyInputFingerprintRow
} from '../replay/work/rtc-topology-input-fingerprint.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from './rtc-topology-errors.ts';
import { RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE, RtcTopologySnapshotRepository } from './rtc-topology-snapshot-repository.ts';

export class RtcTopologyExecutionRepository {
    readonly runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
    private readonly publicationRetentionMs: number;
    private readonly now: () => number;

    constructor(
        runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike,
        publicationRetentionMs: number = RTC_TOPOLOGY_REPLAY_RETENTION_MS,
        now: () => number = () => Date.now()
    ) {
        this.runtimeRepository = runtimeRepository;
        this.publicationRetentionMs = publicationRetentionMs;
        this.now = now;
    }

    async findPublicationForWork(
        groupRef: GroupRef,
        workId: string
    ): Promise<RtcTopologyPublication | undefined> {
        return await new RtcTopologyPublicationRepository(
            this.runtimeRepository,
            this.publicationRetentionMs,
            this.now
        ).findPublicationForWork(groupRef, workId);
    }

    async findSnapshot(
        groupRef: GroupRef
    ): Promise<RallarOverlayTopologySnapshot | undefined> {
        return await new RtcTopologySnapshotRepository(this.runtimeRepository)
            .findSnapshot(groupRef);
    }

    async readTopologyInputFingerprint(groupRef: GroupRef): Promise<string | null> {
        return await new RtcTopologyInputFingerprintRepository(this.runtimeRepository)
            .findFingerprint(groupRef);
    }

    async writeTopologyInputFingerprint(
        transaction: PSqlSql,
        computed: RtcTopologyInputFingerprintRow
    ): Promise<void> {
        await writeRtcTopologyInputFingerprint(transaction, computed);
    }

    async readTopologyMutation(
        groupRef: GroupRef,
        workId: string | null
    ): Promise<RtcTopologyMutationRead> {
        const snapshots = new RtcTopologySnapshotRepository(this.runtimeRepository);
        const publications = new RtcTopologyPublicationRepository(
            this.runtimeRepository,
            this.publicationRetentionMs,
            this.now
        );
        const [snapshot, claimedPublication] = await Promise.all([
            snapshots.findSnapshotEntry(groupRef),
            workId === null
                ? Promise.resolve(undefined)
                : publications.findClaimedPublicationForWork(groupRef, workId)
        ]);
        // Receipts retain their accepted revision when later work advances the snapshot.
        if (
            claimedPublication &&
            (!snapshot ||
                claimedPublication.claim.value.acceptedStorageRevision > snapshot.entry.revision)
        ) {
            throw new RtcTopologyRepositoryInvariantCorruptionError(
                claimedPublication.claim.entry.key,
                'RTC topology execution receipt has no snapshot at or beyond its accepted storage revision'
            );
        }
        return {
            snapshot: snapshot ?? null,
            publicationClaim: claimedPublication
                ? {
                    receipt: claimedPublication.claim.value,
                    publication: claimedPublication.publication
                }
                : null
        };
    }

    async writeTopologyMutation(
        transaction: PSqlSql,
        computed: Extract<RtcTopologyMutationComputed, { outcome: 'write' | 'publish-superseded'; }>
    ): Promise<'committed'> {
        return await writeRtcTopologyMutation(transaction, computed);
    }

    publicationExpireAtTimestamp(): number {
        return this.now() + this.publicationRetentionMs;
    }
}

export async function writeRtcTopologyInputFingerprint(
    transaction: PSqlSql,
    computed: RtcTopologyInputFingerprintRow
): Promise<void> {
    await transaction`
        insert into runtime_state_store (store_namespace,
                                         store_key,
                                         store_value,
                                         expire_at_ts,
                                         updated_ts,
                                         revision)
        values (${RTC_TOPOLOGY_INPUT_FINGERPRINTS_NAMESPACE},
                ${computed.key},
                ${computed.value},
                ${computed.expireAtIsoTimestamp},
                now(),
                0)
        on conflict (store_namespace, store_key)
            do update set store_value  = excluded.store_value,
                          expire_at_ts = excluded.expire_at_ts,
                          updated_ts   = now(),
                          revision     = runtime_state_store.revision + 1
    `;
}

export async function writeRtcTopologyMutation(
    transaction: PSqlSql,
    computed: Extract<RtcTopologyMutationComputed, { outcome: 'write' | 'publish-superseded'; }>
): Promise<'committed'> {
    const runtime = new PSqlRuntimeStateRepository(transaction);
    const snapshot = computed.persistence.snapshot;
    const guard = snapshot.expectedRevision === null
        ? await runtime.insertIfAbsent(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            snapshot.key,
            snapshot.value,
            snapshot.expireAtIsoTimestamp
        )
        : await runtime.upsertIfRevision(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            snapshot.key,
            snapshot.value,
            snapshot.expireAtIsoTimestamp,
            snapshot.expectedRevision
        );
    if (guard.status === 'conflict') {
        throw new RuntimeStateWriteConflictError();
    }
    if (guard.revision !== snapshot.acceptedStorageRevision) {
        throw snapshot.unexpectedRevisionError;
    }
    const publication = computed.persistence.publication;
    if (publication !== null) {
        const claimed = await runtime.insertIfAbsent(
            RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
            publication.receiptKey,
            publication.receiptValue,
            publication.expireAtIsoTimestamp
        );
        if (claimed.status === 'conflict') {
            throw new RuntimeStateWriteConflictError();
        }
        const inserted = await runtime.insertIfAbsent(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            publication.key,
            publication.value,
            publication.expireAtIsoTimestamp
        );
        if (inserted.status === 'conflict') {
            throw publication.collisionError;
        }
    }
    return 'committed';
}
