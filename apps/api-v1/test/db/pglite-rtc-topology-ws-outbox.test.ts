import assert from 'node:assert/strict';

import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { computeTopologyMutation } from '@shared-server/rallar-system/topology/mutation/rtc-topology-mutations.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-execution-repository.ts';
import { toRtcTopologyPublicationId, toRtcTopologyPublicationMessageId } from '@shared-server/rallar-system/topology/persistence/rtc-topology-identifiers.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { hashRtcTopologyExecutionCommand } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository-contracts.ts';
import type { RtcTopologyPublication } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication.ts';
import { writeRtcTopologyPublicationOutbox } from '@shared-server/rallar-system/topology/publication/rtc-topology-ws-outbox-entry.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { AppTopics, EnqueuedType } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { createApiV1TestPGliteDatabaseLifecycle } from './api-v1-test-pglite-database.ts';

Deno.test('PGlite persists distinct topology publications with one logical route', async () => {
    const lifecycle = await createApiV1TestPGliteDatabaseLifecycle();
    const sql = lifecycle.database;
    try {
        const publications = [publication('work-1'), publication('work-2')];
        const entries = await sql.begin(async (transaction) => {
            const written = [];
            for (const item of publications) {
                written.push(await writeRtcTopologyPublicationOutbox(transaction, item));
            }
            return written;
        });
        const rows = await sql<Readonly<{ ri_resource_id: string; ri_resource: string; }>[]>`
      select ri_resource_id, ri_resource
      from resource_inbox
      where ri_type_id = 'WS_OUTBOX'
      order by ri_resource_id
    `;
        const messages = rows.map((row) =>
            JSON.parse(row.ri_resource) as {
                id: { msgId: string; };
                route: RtcTopologyPublication['message']['route'];
                targets: { recipientPeerIds?: readonly string[]; };
            }
        );

        assert.equal(rows.length, 2);
        assert.notDeepEqual(entries[0].key, entries[1].key);
        assert.ok(rows.every((row) => row.ri_resource_id.length <= 128));
        assert.deepEqual(messages[0].route, messages[1].route);
        assert.notEqual(messages[0].id.msgId, messages[1].id.msgId);
        assert.deepEqual(messages[0].targets.recipientPeerIds, ['session-1']);
        assert.deepEqual(messages[1].targets.recipientPeerIds, ['session-1']);
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
        const staleSnapshot = JSON.parse(
            stalePublication.message.payload.resource
        ) as RallarOverlayTopologySnapshot;
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

        const logicalWorkEntry = QueueBoxUtilities.toResourceEntryFromMsg(
            stalePublication.message,
            EnqueuedType.APP_OUTBOX
        );
        const workEntry = {
            ...logicalWorkEntry,
            key: { ...logicalWorkEntry.key, resourceId: 'work-stale-reservation' }
        };
        await createPSqlResourceInboxRepository(sql).entries.write(workEntry);
        await sql`
      update resource_inbox
      set ri_status = 'RESERVED', ri_attempts = 1,
          start_ts = now() at time zone 'UTC'
      where ri_topic_id = ${workEntry.key.topicId}
        and ri_resource_id = ${workEntry.key.resourceId}
        and fk_ext_bank_id = ${workEntry.key.contextId}
    `;
        const reserved = await createPSqlResourceInboxRepository(sql).entries.findAnyByKey(workEntry.key);
        assert.ok(reserved);
        assert.equal(reserved.status, EntityStatus.RESERVED);
        assert.equal(reserved.dequeueAudit.attempts, 1);
        await sql.begin(async (transaction) => {
            await executions.writeTopologyMutation(transaction, computed);
            await writeRtcTopologyPublicationOutbox(transaction, stalePublication);
            assert.equal(
                await createPSqlResourceInboxRepository(transaction).finalization.finishReserved(
                    reserved.key,
                    1,
                    EntityStatus.COMPLETED,
                    new Date()
                ),
                true
            );
        });

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
            (await createPSqlResourceInboxRepository(sql).entries.findAnyByKey(workEntry.key))?.status,
            EntityStatus.COMPLETED
        );
        const wsRows = await sql<{ count: string; }[]>`
      select count(*)::text as count from resource_inbox
      where ri_type_id = 'WS_OUTBOX'
        and ri_resource::jsonb #>> '{id,msgId}' = ${stalePublication.message.id.msgId}
    `;
        assert.equal(Number(wsRows[0]?.count), 1);
    }
    finally {
        await lifecycle.close();
    }
});

function publication(workId: string): RtcTopologyPublication {
    const groupRef = {
        applicationId: 'long-application'.repeat(3),
        workspaceId: 'long-workspace'.repeat(3),
        groupId: 'long-group'.repeat(4)
    };
    const sourceGroupStateCausalRevision = { groupRevision: 6, presenceRevision: 3 };
    const createdAtEpochMs = 1_000;
    const expiresAtMs = 253_402_300_799_999;
    const snapshot: RallarOverlayTopologySnapshot = {
        sourceGroupStateCausalRevision,
        state: 'active',
        overlayId: toScopedOverlayId(groupRef),
        groupRef,
        name: 'Long group',
        topology: 'tree',
        activeSessionIds: ['session-1'],
        nextHopsBySessionId: { 'session-1': [] },
        degreeLimit: 2,
        version: 9,
        createdByClientId: 'owner',
        createdAtEpochMs,
        updatedAtEpochMs: createdAtEpochMs
    };
    const message = {
        id: {
            v: 2 as const,
            msgId: toRtcTopologyPublicationMessageId(workId),
            ts: createdAtEpochMs,
            senderId: 'rallar-server'
        },
        route: {
            topicId: AppTopics.overlayTopology,
            resourceId: `${snapshot.overlayId}:${sourceGroupStateCausalRevision.groupRevision}:` +
                `${sourceGroupStateCausalRevision.presenceRevision}:${snapshot.version}`,
            contextId: groupRef.groupId
        },
        constraints: { expiresAtMs },
        targets: {
            mode: 'broadcast' as const,
            scope: 'room' as const,
            groupRef,
            minSnapshotVersion: 7
        },
        delivery: { reliability: 'best-effort' as const, ack: 'none' as const },
        payload: {
            typeId: AppTopics.overlayTopology,
            contentType: 'application/json' as const,
            resource: JSON.stringify(snapshot)
        },
        audit: { createdBy: 'rallar-server', createdTs: createdAtEpochMs }
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
        message,
        createdAtEpochMs
    };
}
