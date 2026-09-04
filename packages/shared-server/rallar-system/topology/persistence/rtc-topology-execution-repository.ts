import {
    RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
    RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
    RtcTopologyPublicationCollisionError
} from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository-contracts.ts';
import { RtcTopologyPublicationRepository } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository.ts';
import { type RtcTopologyPublication } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import type { RtcTopologyPersistenceComputed } from '../mutation/compute-rtc-topology-persistence.ts';
import type { RtcTopologyMutationComputed, RtcTopologyMutationRead } from '../mutation/rtc-topology-mutations.ts';
import { RTC_TOPOLOGY_REPLAY_RETENTION_MS } from '../replay/consumer/rtc-topology-replay-policy.ts';
import {
    RTC_TOPOLOGY_INPUT_FINGERPRINTS_NAMESPACE,
    RtcTopologyInputFingerprintRepository,
    type RtcTopologyInputFingerprintWrite
} from '../replay/work/rtc-topology-input-fingerprint.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from './rtc-topology-errors.ts';
import {
    RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
    RtcTopologySnapshotRepository
} from './rtc-topology-snapshot-repository.ts';

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
        return await this.publications(this.runtimeRepository)
            .findPublicationForWork(groupRef, workId);
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
        computed: RtcTopologyInputFingerprintWrite
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

    async readTopologyMutation(
        groupRef: GroupRef,
        workId: string | null
    ): Promise<RtcTopologyMutationRead> {
        const snapshots = new RtcTopologySnapshotRepository(this.runtimeRepository);
        const publications = this.publications(this.runtimeRepository);
        const [snapshot, claimedPublication] = await Promise.all([
            snapshots.findSnapshotEntry(groupRef),
            workId === null
                ? Promise.resolve(undefined)
                : publications.findClaimedPublicationForWork(groupRef, workId)
        ]);
        if (
            claimedPublication &&
            claimedPublication.claim.value.acceptedStorageRevision !==
                snapshot?.entry.revision
        ) {
            throw new RtcTopologyRepositoryInvariantCorruptionError(
                claimedPublication.claim.entry.key,
                'RTC topology execution receipt storage revision differs from snapshot'
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
        await writeRtcTopologySnapshot(transaction, computed.persistence.snapshot);
        const publication = computed.persistence.publication;
        if (publication) {
            await writeRtcTopologyPublication(transaction, publication);
        }
        return 'committed';
    }

    publicationExpireAtTimestamp(): number {
        return this.now() + this.publicationRetentionMs;
    }

    private publications(
        repository: RuntimeStateOptimisticTransactionalRepositoryLike
    ): RtcTopologyPublicationRepository {
        return new RtcTopologyPublicationRepository(
            repository,
            this.publicationRetentionMs,
            this.now
        );
    }
}

async function writeRtcTopologySnapshot(
    transaction: PSqlSql,
    snapshot: RtcTopologyPersistenceComputed['snapshot']
): Promise<void> {
    const rows = snapshot.expectedRevision === null
        ? await transaction<Array<{ revision: number | string; }>>`
            insert into runtime_state_store (store_namespace, store_key, store_value,
                                             expire_at_ts, updated_ts, revision)
            values (${RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE}, ${snapshot.key}, ${snapshot.value},
                    ${snapshot.expireAtIsoTimestamp}, now(), 0)
            on conflict (store_namespace, store_key) do nothing
            returning revision
        `
        : await transaction<Array<{ revision: number | string; }>>`
            update runtime_state_store
            set store_value = ${snapshot.value},
                expire_at_ts = ${snapshot.expireAtIsoTimestamp},
                updated_ts = now(),
                revision = revision + 1
            where store_namespace = ${RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE}
              and store_key = ${snapshot.key}
              and revision = ${snapshot.expectedRevision}
            returning revision
        `;
    if (!rows[0]) {
        throw new RuntimeStateWriteConflictError();
    }
    if (Number(rows[0].revision) !== snapshot.acceptedStorageRevision) {
        throw new RtcTopologyRepositoryInvariantCorruptionError(
            snapshot.key,
            'RTC topology write returned an unexpected storage revision'
        );
    }
}

async function writeRtcTopologyPublication(
    transaction: PSqlSql,
    publication: NonNullable<RtcTopologyPersistenceComputed['publication']>
): Promise<void> {
    const claims = await transaction<Array<{ revision: number | string; }>>`
        insert into runtime_state_store (store_namespace, store_key, store_value,
                                         expire_at_ts, updated_ts, revision)
        values (${RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE},
                ${publication.receiptKey}, ${publication.receiptValue},
                ${publication.expireAtIsoTimestamp}, now(), 0)
        on conflict (store_namespace, store_key) do nothing
        returning revision
    `;
    if (!claims[0]) {
        throw new RuntimeStateWriteConflictError();
    }
    const publications = await transaction<Array<{ revision: number | string; }>>`
        insert into runtime_state_store (store_namespace, store_key, store_value,
                                         expire_at_ts, updated_ts, revision)
        values (${RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE}, ${publication.key},
                ${publication.value}, ${publication.expireAtIsoTimestamp}, now(), 0)
        on conflict (store_namespace, store_key) do nothing
        returning revision
    `;
    if (!publications[0]) {
        throw new RtcTopologyPublicationCollisionError(publication.key);
    }
}
