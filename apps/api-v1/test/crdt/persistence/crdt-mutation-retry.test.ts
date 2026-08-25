import assert from 'node:assert/strict';

import { RALLAR_CRDT_PROTOCOL_VERSION, toRallarCrdtDocumentKey, type RallarCrdtDocumentRef, type RallarCrdtSnapshotEnvelope } from '@shared/crdt/mod.ts';

import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { PSqlCrdtLogRepository } from '@shared-server/rallar-system/crdt/persistence/psql-crdt-log-repository.ts';

import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';

import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import { decodeExactSnapshotEnvelope } from '@shared-server/rallar-system/crdt/mutation/decoding/decode-exact-snapshot-envelope.ts';

import { decodeCrdtMutationResult } from '@shared-server/rallar-system/crdt/mutation/decode-crdt-mutation-result.ts';

import { createApiCrdtInboxService } from '../../../src/crdt/create-api-crdt-inbox-service.ts';
import type { PGliteSql } from '../../../src/db/pglite-sql-adapter.ts';
import { toResilienceDto } from '../../api-v1-test-queue-resilience.ts';
import { waitForPGliteQueueRow } from '../../db/pglite-app-inbox-test-runtime.ts';
import { withPGliteSql } from '../../db/pglite-auth-test-harness.ts';

import { queueNow, update, withCompetingWrite } from '../crdt-api-test-fixtures.ts';

interface MigratedSnapshotContractRow {
    readonly document_key: string;
    readonly document_revision: string | number;
    readonly reason: string | null;
    readonly snapshot_envelope: string;
    readonly reason_nullable: string;
}

interface RetryMutationCountsRow {
    readonly updates: string;
    readonly owner_updates: string;
    readonly outbox: string;
}

interface ResourceInboxResultPayloadRow {
    readonly ris_resource: string;
}

interface RetryMutationScenario {
    readonly service: ReturnType<typeof createApiCrdtInboxService>;
    readonly inboxQueueReader: InboxQueueReader;
    readonly documentAuthorityReadCount: () => number;
}

interface LegacySnapshotFixture {
    readonly document: RallarCrdtDocumentRef;
    readonly reason: string | null;
}

const LEGACY_SNAPSHOT_FIXTURES: readonly LegacySnapshotFixture[] = [
    { document: legacyDocument('physical'), reason: 'api-v1-admin-compaction' },
    { document: legacyDocument('null'), reason: null },
    { document: legacyDocument('blank'), reason: '   ' }
];

Deno.test(
    'compatible migration binds omitted legacy snapshot reasons in row and envelope',
    verifyCompatibleSnapshotReasonMigration
);

Deno.test(
    'real SQL CAS conflict retries from revoked room membership and commits no owner effect',
    verifyRealSqlCasConflictRetry
);

async function verifyCompatibleSnapshotReasonMigration(): Promise<void> {
    await withPGliteSql(runCompatibleSnapshotReasonMigration);
}

async function runCompatibleSnapshotReasonMigration(sql: PGliteSql): Promise<void> {
    await sql`alter table crdt_snapshots alter column reason drop not null`;
    await insertLegacySnapshotFixtures(sql);
    const migration = await Deno.readTextFile(
        new URL(
            '../../../prisma/migrations/20260723170000_crdt_trusted_identity_required/migration.sql',
            import.meta.url
        )
    );
    await sql.exec(migration);

    const rows = await readMigratedSnapshotContract(sql);
    assertMigratedSnapshotContract(rows);
    await assertMigratedSnapshotRepositoryReads(sql);
}

async function insertLegacySnapshotFixtures(sql: PGliteSql): Promise<void> {
    for (const fixture of LEGACY_SNAPSHOT_FIXTURES) {
        const documentKey = toRallarCrdtDocumentKey(fixture.document);
        const envelope = legacySnapshot(fixture.document);
        await sql`
          insert into crdt_documents (
              document_key, application_id, workspace_id, document_scope,
              document_type, document_id, document_ref, document_revision,
              snapshot_count
          ) values (
              ${documentKey}, 'app-1', null, 'app', 'checklist',
              ${fixture.document.documentId}, ${JSON.stringify(fixture.document)}, 0, 1
          )
      `;
        await sql`
          insert into crdt_snapshots (
              document_key, snapshot_id, append_sequence, snapshot_envelope,
              created_at_ts, reason
          ) values (
              ${documentKey}, ${envelope.snapshotId}, 0, ${JSON.stringify(envelope)},
              ${new Date(envelope.createdAtEpochMs)}, ${fixture.reason}
          )
      `;
    }
}

async function readMigratedSnapshotContract(
    sql: PGliteSql
): Promise<readonly MigratedSnapshotContractRow[]> {
    return await sql<MigratedSnapshotContractRow[]>`
      select d.document_key, d.document_revision, s.reason, s.snapshot_envelope,
             c.is_nullable as reason_nullable
      from crdt_documents d
      join crdt_snapshots s on s.document_key = d.document_key
      join information_schema.columns c
        on c.table_name = 'crdt_snapshots' and c.column_name = 'reason'
      order by d.document_id
  `;
}

function assertMigratedSnapshotContract(rows: readonly MigratedSnapshotContractRow[]): void {
    assert.deepEqual(
        rows.map((row) => {
            const envelope = decodeExactSnapshotEnvelope(JSON.parse(row.snapshot_envelope));
            return {
                documentId: envelope.document.documentId,
                documentRevision: Number(row.document_revision),
                logicalReason: envelope.metadata.reason,
                physicalReason: row.reason,
                reasonNullable: row.reason_nullable
            };
        }),
        [
            {
                documentId: 'legacy-blank',
                documentRevision: 1,
                logicalReason: 'legacy-import',
                physicalReason: 'legacy-import',
                reasonNullable: 'NO'
            },
            {
                documentId: 'legacy-null',
                documentRevision: 1,
                logicalReason: 'legacy-import',
                physicalReason: 'legacy-import',
                reasonNullable: 'NO'
            },
            {
                documentId: 'legacy-physical',
                documentRevision: 1,
                logicalReason: 'api-v1-admin-compaction',
                physicalReason: 'api-v1-admin-compaction',
                reasonNullable: 'NO'
            }
        ]
    );
}

async function assertMigratedSnapshotRepositoryReads(sql: PGliteSql): Promise<void> {
    const repository = new PSqlCrdtLogRepository(sql);
    for (const fixture of LEGACY_SNAPSHOT_FIXTURES) {
        const snapshot = await repository.readSnapshot(fixture.document);
        const expectedReason = fixture.reason?.trim() ? fixture.reason : 'legacy-import';
        assert.equal(snapshot?.metadata.reason, expectedReason);
    }
}

async function verifyRealSqlCasConflictRetry(): Promise<void> {
    await withPGliteSql(async (sql) => {
        const now = await queueNow(sql);
        const scenario = createRetryMutationScenario(sql, now);
        await enqueueOwnerUpdate(scenario.service, now);
        await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
        await scenario.inboxQueueReader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            toResilienceDto()
        );
        await assertRetryMutationOutcome(sql, scenario.documentAuthorityReadCount());
    });
}

function createRetryMutationScenario(sql: PGliteSql, now: number): RetryMutationScenario {
    let membershipAllowed = true;
    let documentAuthorityReads = 0;
    const database = withCompetingWrite(sql, now, () => {
        membershipAllowed = false;
    });
    const resourceInbox = createPSqlResourceInboxRepository(sql);
    const inboxQueueReader = new InboxQueueReader(new PSqlQueueBox(resourceInbox));
    return {
        service: createApiCrdtInboxService({
            inboxQueueReader,
            resourceInboxRepository: resourceInbox.entries,
            resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
            database,
            serviceId: 'server-1',
            timing: undefined,
            options: { nowEpochMs: () => now },
            wakeQueueEngine: () => undefined,
            currentAuthority: {
                readSession: (sessionId: string) =>
                    Promise.resolve({
                        clientId: 'client-1',
                        username: 'principal-1',
                        sessionId,
                        expiresAtEpochMs: now + 60_000
                    }),
                adminClientIds: ['admin'],
                authorizeDocument: () => {
                    documentAuthorityReads += 1;
                    return Promise.resolve({
                        allowed: membershipAllowed,
                        code: membershipAllowed ? 'allowed' : 'authorization-scope-denied'
                    });
                }
            },
            policies: [{ documentType: 'checklist', rollout: 'production' }]
        }),
        inboxQueueReader,
        documentAuthorityReadCount: () => documentAuthorityReads
    };
}

async function enqueueOwnerUpdate(
    service: ReturnType<typeof createApiCrdtInboxService>,
    now: number
): Promise<void> {
    await service.createAndEnqueueAppend({
        update: update('owner-update', now - 1_000),
        deliveryId: 'owner-delivery',
        actor: {
            actorId: 'client-1',
            principalId: 'principal-1',
            sessionId: 'session-1',
            serverId: 'server-1'
        },
        responseAudience: {
            kind: 'room',
            senderSessionId: 'session-1',
            topicId: 'room.crdt',
            contextId: 'group-1'
        },
        capturedAtEpochMs: now,
        expireAtEpochMs: now + 60_000
    });
}

async function assertRetryMutationOutcome(
    sql: PGliteSql,
    documentAuthorityReads: number
): Promise<void> {
    const [counts] = await sql<RetryMutationCountsRow[]>`
      select
          (select count(*) from crdt_updates)::text as updates,
          (select count(*) from crdt_updates where update_id = 'owner-update')::text
              as owner_updates,
          (select count(*) from resource_inbox where ri_type_id = 'WS_OUTBOX')::text
              as outbox
  `;
    assert.deepEqual(counts, { updates: '1', owner_updates: '0', outbox: '0' });
    assert.equal(documentAuthorityReads, 2);
    const [completion] = await sql<ResourceInboxResultPayloadRow[]>`
      select ris_resource from resource_inbox_results
      where ris_topic_id = 'app-inbox.crdt-state'
        and ris_resource_id = 'owner-delivery'
  `;
    assert.ok(completion);
    const result = decodeCrdtMutationResult(JSON.parse(completion.ris_resource));
    assert.equal(result.code, 'authorization-scope-denied');
}

function legacyDocument(suffix: string): RallarCrdtDocumentRef {
    return {
        applicationId: 'app-1',
        scope: 'app',
        documentType: 'checklist',
        documentId: `legacy-${suffix}`
    };
}

function legacySnapshot(document: RallarCrdtDocumentRef): RallarCrdtSnapshotEnvelope {
    return {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        document,
        snapshotId: `snapshot-${document.documentId}`,
        schemaVersion: 1,
        createdAtEpochMs: 10_000,
        maxLamport: 0,
        includedUpdateIds: [],
        value: { legacy: true },
        metadata: { updateCount: 0 }
    };
}
