import assert from 'node:assert/strict';
import {
  RALLAR_CRDT_PROTOCOL_VERSION,
  type RallarCrdtDocumentRef,
  type RallarCrdtSnapshotEnvelope,
  toRallarCrdtDocumentKey,
} from '@shared/crdt/mod.ts';
import { PSqlCrdtLogRepository } from '@shared-server/rallar-system/crdt/persistence/psql-crdt-log-repository.ts';
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { toResilienceDto } from '../../../src/middleware-resilience.ts';
import { createApiCrdtInboxService } from '../../../src/services/create-api-crdt-inbox-service.ts';
import {
  createConfiguredApiMutationInboxFactories,
  readConfiguredCrdtPolicies,
} from '../../../src/services/create-api-mutation-inbox-factories.ts';
import { waitForPGliteQueueRow, withPGliteSql } from '../../db/pglite-auth-test-harness.ts';
import { appendCommand, queueNow, update, withCompetingWrite } from '../crdt-api-test-fixtures.ts';

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

Deno.test('configured production factory resolves absent CRDT policy to disabled and denies writes', async () => {
  const previous = Deno.env.get('RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON');
  Deno.env.delete('RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON');
  try {
    assert.deepEqual(readConfiguredCrdtPolicies(), [{
      documentType: '*',
      rollout: 'disabled',
    }]);
    await withPGliteSql(async (sql) => {
      const now = await queueNow(sql);
      const resourceInbox = new ResourceInboxRepository(sql);
      const queue = new PSqlQueueBox(resourceInbox);
      const factories = createConfiguredApiMutationInboxFactories({
        resourceInboxRepository: resourceInbox,
        resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
        database: sql,
        serviceId: 'server-1',
        timing: undefined,
        options: { nowEpochMs: () => now },
        readSession: (sessionId: string) =>
          Promise.resolve({
            clientId: 'client-1',
            username: 'principal-1',
            sessionId,
            expiresAtEpochMs: now + 60_000,
          }),
        authorizeDocument: () =>
          Promise.resolve({
            allowed: true,
            code: 'allowed',
          }),
      });
      const service = factories.createAppCrdtInboxService({
        inboxQueueReader: new InboxQueueReader(queue),
        outboxQueueReader: new OutboxQueueReader(queue),
        appInboxResilience: toResilienceDto(),
        wakeQueueEngine: () => undefined,
      });
      const read = await service.mutationService.read(
        await appendCommand({
          now,
          commandId: 'default-deny',
          updateId: 'default-deny-update',
        }),
      );

      assert.equal(read.featureDecision.allowed, false);
    });
  } finally {
    if (previous === undefined) {
      Deno.env.delete('RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON');
    } else {
      Deno.env.set('RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON', previous);
    }
  }
});

Deno.test('configured CRDT policy parser accepts only the authoritative rollout vocabulary', () => {
  const previous = Deno.env.get('RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON');
  try {
    for (
      const rollout of [
        'disabled',
        'experimental-local',
        'experimental-live',
        'durable-beta',
        'production',
      ]
    ) {
      Deno.env.set(
        'RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON',
        JSON.stringify([{
          documentType: 'checklist',
          rollout,
        }]),
      );
      assert.equal(readConfiguredCrdtPolicies()?.[0]?.rollout, rollout);
    }
    for (const rollout of ['experimental', 'beta', 'durable_beta']) {
      Deno.env.set(
        'RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON',
        JSON.stringify([{
          documentType: 'checklist',
          rollout,
        }]),
      );
      assert.throws(() => readConfiguredCrdtPolicies(), /policy|rollout|invalid/i);
    }
  } finally {
    if (previous === undefined) {
      Deno.env.delete('RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON');
    } else {
      Deno.env.set('RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON', previous);
    }
  }
});

Deno.test('compatible migration binds omitted legacy snapshot reasons in row and envelope', async () => {
  await withPGliteSql(async (sql) => {
    const fixtures = [
      { document: legacyDocument('physical'), reason: 'api-v1-admin-compaction' },
      { document: legacyDocument('null'), reason: null },
      { document: legacyDocument('blank'), reason: '   ' },
    ] as const;
    await sql`alter table crdt_snapshots alter column reason drop not null`;
    for (const fixture of fixtures) {
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
    const migration = await Deno.readTextFile(
      new URL(
        '../../../prisma/migrations/20260723170000_crdt_trusted_identity_required/migration.sql',
        import.meta.url,
      ),
    );
    await sql.exec(migration);

    const rows = await sql<MigratedSnapshotContractRow[]>`
            select d.document_key, d.document_revision, s.reason, s.snapshot_envelope,
                   c.is_nullable as reason_nullable
            from crdt_documents d
            join crdt_snapshots s on s.document_key = d.document_key
            join information_schema.columns c
              on c.table_name = 'crdt_snapshots' and c.column_name = 'reason'
            order by d.document_id
        `;
    assert.deepEqual(
      rows.map((row) => ({
        documentId: (JSON.parse(row.snapshot_envelope) as RallarCrdtSnapshotEnvelope)
          .document.documentId,
        documentRevision: Number(row.document_revision),
        logicalReason: (JSON.parse(row.snapshot_envelope) as RallarCrdtSnapshotEnvelope)
          .metadata.reason,
        physicalReason: row.reason,
        reasonNullable: row.reason_nullable,
      })),
      [
        {
          documentId: 'legacy-blank',
          documentRevision: 1,
          logicalReason: 'legacy-import',
          physicalReason: 'legacy-import',
          reasonNullable: 'NO',
        },
        {
          documentId: 'legacy-null',
          documentRevision: 1,
          logicalReason: 'legacy-import',
          physicalReason: 'legacy-import',
          reasonNullable: 'NO',
        },
        {
          documentId: 'legacy-physical',
          documentRevision: 1,
          logicalReason: 'api-v1-admin-compaction',
          physicalReason: 'api-v1-admin-compaction',
          reasonNullable: 'NO',
        },
      ],
    );
    const repository = new PSqlCrdtLogRepository(sql);
    for (const fixture of fixtures) {
      const snapshot = await repository.readSnapshot(fixture.document);
      const expectedReason = fixture.reason?.trim() ? fixture.reason : 'legacy-import';
      assert.equal(snapshot?.metadata.reason, expectedReason);
    }
  });
});

Deno.test('real SQL CAS conflict retries from revoked room membership and commits no owner effect', async () => {
  await withPGliteSql(async (sql) => {
    const now = await queueNow(sql);
    let membershipAllowed = true;
    let documentAuthorityReads = 0;
    const database = withCompetingWrite(sql, now, () => {
      membershipAllowed = false;
    });
    const resourceInbox = new ResourceInboxRepository(sql);
    const service = createApiCrdtInboxService({
      inboxQueueReader: new InboxQueueReader(new PSqlQueueBox(resourceInbox)),
      resourceInboxRepository: resourceInbox,
      resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
      database,
      serviceId: 'server-1',
      options: { nowEpochMs: () => now },
      currentAuthority: {
        readSession: (sessionId: string) =>
          Promise.resolve({
            clientId: 'client-1',
            username: 'principal-1',
            sessionId,
            expiresAtEpochMs: now + 60_000,
          }),
        adminClientIds: ['admin'],
        authorizeDocument: () => {
          documentAuthorityReads += 1;
          return Promise.resolve({
            allowed: membershipAllowed,
            code: membershipAllowed ? 'allowed' : 'authorization-scope-denied',
          });
        },
      } as never,
      policies: [{ documentType: 'checklist', rollout: 'production' }],
    });
    await service.createAndEnqueueAppend({
      update: update('owner-update', now - 1_000),
      deliveryId: 'owner-delivery',
      actor: {
        actorId: 'client-1',
        principalId: 'principal-1',
        sessionId: 'session-1',
        serverId: 'server-1',
      },
      responseAudience: {
        kind: 'room',
        senderSessionId: 'session-1',
        topicId: 'room.crdt',
        contextId: 'group-1',
      },
      capturedAtEpochMs: now,
      expireAtEpochMs: now + 60_000,
    });
    await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
    await service.inbox.dequeueInbox(
      InboxQueueReader.INBOX_DEQUEUE_TYPES,
      toResilienceDto(),
    );

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
    assert.equal(JSON.parse(completion!.ris_resource).code, 'authorization-scope-denied');
  });
});

function legacyDocument(suffix: string): RallarCrdtDocumentRef {
  return {
    applicationId: 'app-1',
    scope: 'app',
    documentType: 'checklist',
    documentId: `legacy-${suffix}`,
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
    metadata: { updateCount: 0 },
  };
}
