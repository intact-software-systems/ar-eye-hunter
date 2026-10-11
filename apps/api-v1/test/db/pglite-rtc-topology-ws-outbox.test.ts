import assert from 'node:assert/strict';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import {
    createPSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { ResourceInboxInvariantCorruptionError } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { writeAppOutboxInsert } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { computeTopologyMutation } from '@shared-server/rallar-system/topology/mutation/rtc-topology-mutations.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-execution-repository.ts';
import { toRtcTopologyPublicationId } from '@shared-server/rallar-system/topology/persistence/rtc-topology-identifiers.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { writeRtcTopologyOutboxProvenance } from '@shared-server/rallar-system/topology/publication/rtc-topology-outbox-provenance.ts';
import { hashRtcTopologyExecutionCommand } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository-contracts.ts';
import type { RtcTopologyPublication } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication.ts';
import {
    computeRtcTopologyPublicationOutboxWrites
} from '@shared-server/rallar-system/topology/publication/rtc-topology-ws-outbox-entry.ts';
import { PSqlRtcTopologyDeliveryRepository } from '@shared-server/rallar-system/topology/replay/postgres/p-sql-rtc-topology-delivery-repository.ts';
import {
    computeRtcTopologyReservationFinish,
    finishRtcTopologyReservation
} from '@shared-server/rallar-system/topology/replay/work/rtc-topology-work-completion.ts';
import {
    computeRtcTopologyPublicationDeliveryWrite,
    writePublicationDelivery,
    writeRtcTopologyPublicationTransaction
} from '@shared-server/rallar-system/topology/replay/work/write-rtc-topology-publication-transaction.ts';
import { WsOutboxProvenanceReader } from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { createApiV1TestPGliteDatabaseLifecycle } from './api-v1-test-pglite-database.ts';

interface OutboxRow {
    readonly ri_resource_id: string;
    readonly ri_resource: string;
}
interface CountRow {
    readonly count: string;
}

Deno.test('PGlite persists distinct topology publications with one logical route', async () => {
    const lifecycle = await createApiV1TestPGliteDatabaseLifecycle();
    const sql = lifecycle.database;
    try {
        const publications = [publication('work-1'), publication('work-2')];
        const outboxWrites = publications.flatMap(computeRtcTopologyPublicationOutboxWrites);
        await sql.begin(async (transaction) => {
            for (const write of outboxWrites) {
                await writeAppOutboxInsert(transaction, write);
            }
        });
        const rows = await sql<OutboxRow[]>`
      select ri_resource_id, ri_resource
      from resource_inbox
      where ri_type_id = 'WS_OUTBOX'
      order by ri_resource_id
    `;
        const messages = rows.map((row) => decodePersistedALMessage(row.ri_resource));

        assert.equal(rows.length, 2);
        assert.notDeepEqual(outboxWrites[0].entry.key, outboxWrites[1].entry.key);
        assert.ok(rows.every((row) => row.ri_resource_id.length <= 128));
        assert.deepEqual(messages[0].route, messages[1].route);
        assert.notEqual(messages[0].id.msgId, messages[1].id.msgId);
        assert.deepEqual(messages[0].targets?.mode === 'broadcast' ? messages[0].targets.recipientPeerIds : undefined, ['session-1']);
        assert.deepEqual(messages[1].targets?.mode === 'broadcast' ? messages[1].targets.recipientPeerIds : undefined, ['session-1']);
    }
    finally {
        await lifecycle.close();
    }
});

Deno.test('PGlite atomically publishes stale topology work without regressing latest topology', async () => {
    const lifecycle = await createApiV1TestPGliteDatabaseLifecycle();
    const sql = lifecycle.database;
    try {
        const stalePublication = publication('work-stale');
        const staleSnapshot = stalePublication.snapshot;
        const currentSnapshot: RallarOverlayTopologySnapshot = {
            ...staleSnapshot,
            sourceGroupStateCausalRevision: { groupRevision: 7, presenceRevision: 4 },
            version: 10,
            updatedAtEpochMs: 3_000
        };
        const runtime = new PSqlRuntimeStateRepository(sql);
        const snapshots = new RtcTopologySnapshotRepository(runtime);
        assert.equal(await snapshots.observeSnapshot(currentSnapshot), 'inserted');
        const before = await snapshots.findSnapshotEntry(currentSnapshot.groupRef);
        assert.ok(before);
        const executions = new RtcTopologyExecutionRepository(runtime);
        const read = await executions.readTopologyMutation(
            stalePublication.groupRef,
            stalePublication.workId
        );
        const computed = computeTopologyMutation({
            read,
            candidate: staleSnapshot,
            publication: stalePublication,
            facts: {
                publicationExpireAtTimestamp: 253_402_300_799_999,
                commandHash: await hashRtcTopologyExecutionCommand(stalePublication),
                attemptCount: 1
            }
        });
        assert.equal(computed.outcome, 'publish-superseded');
        if (computed.outcome !== 'publish-superseded') {
            return;
        }

        const delivery = await computeRtcTopologyPublicationDeliveryWrite(stalePublication, undefined);
        const { outboxWrites } = delivery;
        const logicalWorkEntry = outboxWrites[0].entry;
        const workEntry = {
            ...logicalWorkEntry,
            typeId: EnqueuedType.APP_OUTBOX,
            key: { ...logicalWorkEntry.key, resourceId: 'work-stale-reservation' }
        };
        await createPSqlResourceInboxRepository(sql, () => new Date()).entries.write(workEntry);
        await sql`
      update resource_inbox
      set ri_status = 'RESERVED', ri_attempts = 1,
          start_ts = now() at time zone 'UTC'
      where ri_topic_id = ${workEntry.key.topicId}
        and ri_resource_id = ${workEntry.key.resourceId}
        and fk_ext_bank_id = ${workEntry.key.contextId}
    `;
        const reserved = await createPSqlResourceInboxRepository(sql, () => new Date()).entries.findAnyByKey(workEntry.key);
        assert.ok(reserved);
        assert.equal(reserved.status, EntityStatus.RESERVED);
        assert.equal(reserved.dequeueAudit.attempts, 1);
        const reservationFinish = computeRtcTopologyReservationFinish(reserved, new Date());
        const stringify = JSON.stringify;
        JSON.stringify = () => {
            throw new Error('serialization must finish before the transaction');
        };
        try {
            await sql.begin(async (transaction) => {
                await executions.writeTopologyMutation(transaction, computed);
                await writePublicationDelivery(transaction, delivery, undefined);
                await finishRtcTopologyReservation(transaction, reservationFinish);
            });
        }
        finally {
            JSON.stringify = stringify;
        }

        const after = await snapshots.findSnapshotEntry(currentSnapshot.groupRef);
        assert.ok(after);
        assert.deepEqual(after.value, currentSnapshot);
        assert.equal(after.entry.revision, before.entry.revision + 1);
        assert.deepEqual(
            await executions.findPublicationForWork(
                stalePublication.groupRef,
                stalePublication.workId
            ),
            stalePublication
        );
        assert.equal(
            (await createPSqlResourceInboxRepository(sql, () => new Date()).entries.findAnyByKey(workEntry.key))?.status,
            EntityStatus.COMPLETED
        );
        const wsRows = await sql<CountRow[]>`
      select count(*)::text as count from resource_inbox
      where ri_type_id = 'WS_OUTBOX'
    `;
        assert.equal(Number(wsRows[0]?.count), outboxWrites.length);
        const reader = new WsOutboxProvenanceReader({ repository: runtime, nowMs: Date.now });
        const page = await createPSqlResourceInboxRepository(sql, () => new Date()).entries.findAnyByKey(outboxWrites[0].entry.key);
        assert.ok(page);
        assert.deepEqual(await reader.readProducerProvenance(decodePersistedALMessage(page.resource), page), {
            admittedAudience: ['session-1'],
            recipientScope: undefined
        });
    }
    finally {
        await lifecycle.close();
    }
});

for (const collision of ['none', 'last-page', 'last-proof', 'reservation'] as const) {
    Deno.test(`PGlite atomically publishes 1500 topology sessions with ${collision} collision`, async () => {
        const lifecycle = await createApiV1TestPGliteDatabaseLifecycle();
        const sql = lifecycle.database;
        try {
            const candidate = publication('large-topology', 1500);
            const publisherStreamId = '00000000-0000-4000-8000-000000000013';
            const append = new PSqlRtcTopologyDeliveryRepository(sql);
            await append.registerStream({ streamId: publisherStreamId, leaseDurationMs: 60_000 });
            const delivery = await computeRtcTopologyPublicationDeliveryWrite(candidate, publisherStreamId);
            const { outboxWrites } = delivery;
            assert.ok(new TextEncoder().encode(JSON.stringify(candidate.snapshot)).byteLength > 64 * 1024);
            assert.ok(outboxWrites.length > Math.ceil(candidate.recipientSessionIds.length / 256));
            assert.deepEqual(computeRtcTopologyPublicationOutboxWrites(candidate), outboxWrites);
            const lastPage = outboxWrites.at(-1);
            assert.ok(lastPage);
            const runtime = new PSqlRuntimeStateRepository(sql);
            const executions = new RtcTopologyExecutionRepository(runtime);
            const mutation = computeTopologyMutation({
                read: await executions.readTopologyMutation(candidate.groupRef, candidate.workId),
                candidate: candidate.snapshot,
                publication: candidate,
                facts: {
                    publicationExpireAtTimestamp: candidate.expiresAtEpochMs,
                    commandHash: await hashRtcTopologyExecutionCommand(candidate),
                    attemptCount: 1
                }
            });
            assert.equal(mutation.outcome, 'write');
            if (mutation.outcome !== 'write') {
                throw new Error('Expected a new publication mutation');
            }
            const reservation = await writeReservedWork(sql, outboxWrites[0].entry);
            const reservationFinish = computeRtcTopologyReservationFinish(reservation, new Date());
            if (collision === 'last-page') {
                await writeAppOutboxInsert(sql, lastPage);
            }
            if (collision === 'last-proof') {
                await writeRtcTopologyOutboxProvenance(sql, [delivery.provenanceWrites.at(-1)!]);
            }

            const write = () =>
                writeRtcTopologyPublicationTransaction({ database: sql, executionRepository: executions, deliveryAppend: append }, {
                    mutation,
                    promotionWrite: null,
                    connectWrites: [],
                    fingerprint: null,
                    delivery,
                    reservationFinish: collision === 'reservation' ? { ...reservationFinish, expectedAttempts: 9 } : reservationFinish
                });
            if (collision === 'last-page' || collision === 'last-proof') {
                await assert.rejects(write, ResourceInboxInvariantCorruptionError);
            }
            else if (collision === 'reservation') {
                await assert.rejects(write);
            }
            else {
                await write();
            }

            const rows = await sql<OutboxRow[]>`
                select ri_resource_id, ri_resource from resource_inbox
                where ri_type_id = 'WS_OUTBOX' order by ri_resource_id
            `;
            const expected = (collision === 'last-page' ? [lastPage] : collision === 'none' ? outboxWrites : [])
                .map(({ entry }) => ({ ri_resource_id: entry.key.resourceId, ri_resource: entry.resource }))
                .sort((left, right) => left.ri_resource_id.localeCompare(right.ri_resource_id));
            assert.deepEqual(rows, expected);
            const proofs = await sql<CountRow[]>`select count(*)::text as count from runtime_state_store where store_namespace = 'ws-outbox-provenance'`;
            assert.equal(Number(proofs[0].count), collision === 'last-proof' ? 1 : collision === 'none' ? outboxWrites.length : 0);
            assert.equal(
                (await createPSqlResourceInboxRepository(sql, () => new Date()).entries.findAnyByKey(reservation.key))?.status,
                collision === 'none' ? EntityStatus.COMPLETED : EntityStatus.RESERVED
            );
            assert.deepEqual(await executions.findPublicationForWork(candidate.groupRef, candidate.workId), collision === 'none' ? candidate : undefined);
            const snapshots = new RtcTopologySnapshotRepository(runtime);
            assert.deepEqual((await snapshots.findSnapshotEntry(candidate.groupRef))?.value, collision === 'none' ? candidate.snapshot : undefined);
            const appended = await append.findPublicationDelivery({ groupRef: candidate.groupRef, publicationId: candidate.publicationId });
            assert.equal(appended?.sequence, collision === 'none' ? 1 : undefined);
            const head = await sql<
                readonly { head_sequence: number; }[]
            >`select head_sequence::int from rtc_topology_delivery_stream where stream_id = ${publisherStreamId}`;
            assert.equal(head[0].head_sequence, collision === 'none' ? 1 : 0);
        }
        finally {
            await lifecycle.close();
        }
    });
}

async function writeReservedWork(sql: PSqlSql, page: ResourceEntry): Promise<ResourceEntry> {
    const work = { ...page, typeId: EnqueuedType.APP_OUTBOX, key: { ...page.key, resourceId: 'topology-work-reservation' } };
    const repository = createPSqlResourceInboxRepository(sql, () => new Date());
    await repository.entries.write(work);
    await sql`update resource_inbox set ri_status = 'RESERVED', ri_attempts = 1, start_ts = now() at time zone 'UTC'
        where ri_topic_id = ${work.key.topicId} and ri_resource_id = ${work.key.resourceId} and fk_ext_bank_id = ${work.key.contextId}`;
    const reserved = await repository.entries.findAnyByKey(work.key);
    assert.ok(reserved);
    return reserved;
}

function publication(workId: string, sessionCount = 1): RtcTopologyPublication {
    const groupRef = {
        applicationId: 'long-application'.repeat(3),
        workspaceId: 'long-workspace'.repeat(3),
        groupId: 'long-group'.repeat(4)
    };
    const sourceGroupStateCausalRevision = { groupRevision: 6, presenceRevision: 3 };
    const createdAtEpochMs = 1_000;
    const expiresAtMs = 253_402_300_799_999;
    const activeSessionIds = Array.from({ length: sessionCount }, (_, index) => `session-${index + 1}`).sort();
    const snapshot: RallarOverlayTopologySnapshot = {
        sourceGroupStateCausalRevision,
        state: 'active',
        overlayId: toScopedOverlayId(groupRef),
        groupRef,
        name: 'Long group',
        topology: 'tree',
        activeSessionIds,
        nextHopsBySessionId: Object.fromEntries(
            activeSessionIds.map((
                id,
                index
            ) => [id, activeSessionIds.slice(Math.max(0, index - 1), index).concat(activeSessionIds.slice(index + 1, index + 2))])
        ),
        degreeLimit: 2,
        version: 9,
        createdByClientId: 'owner',
        createdAtEpochMs,
        updatedAtEpochMs: createdAtEpochMs
    };
    return {
        publicationId: toRtcTopologyPublicationId({
            workId,
            sourceGroupStateCausalRevision,
            overlayVersion: snapshot.version
        }),
        workId,
        groupRef,
        sourceGroupStateCausalRevision,
        overlayVersion: snapshot.version,
        targetGroupSnapshotVersion: 7,
        recipientSessionIds: snapshot.activeSessionIds,
        snapshot,
        expiresAtEpochMs: expiresAtMs,
        createdAtEpochMs
    };
}
