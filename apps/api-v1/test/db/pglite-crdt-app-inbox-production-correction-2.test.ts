import assert from 'node:assert/strict';
import {
  RALLAR_CRDT_OPERATION_VERSION,
  RALLAR_CRDT_PROTOCOL_VERSION,
  type RallarCrdtDocumentRef,
  type RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import type { PSqlSql, PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { createCrdtMutationCommand } from '@shared-server/rallar-system/services/crdt-mutations.ts';
import { CrdtMutationConflictError } from '@shared-server/rallar-system/services/crdt-mutation-contracts.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { toResilienceDto } from '../../src/middleware-resilience.ts';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import { createApiCrdtInboxService } from '../../src/services/create-api-crdt-inbox-service.ts';
import {
  readPGliteDatabaseEpochMs,
  waitForPGliteQueueRow,
  withPGliteSql,
} from './pglite-auth-test-harness.ts';

const DOCUMENT: RallarCrdtDocumentRef = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
  scope: 'room',
  documentType: 'checklist',
  documentId: 'document-1',
  roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' },
};

Deno.test('production CRDT factory fails closed when document policies are unavailable', async () => {
  await withPGliteSql(async (sql) => {
    const now = await pgliteQueueNow(sql);
    const service = productionService(sql, sql, now);
    const command = await appendCommand(now, 'policy-delivery', 'policy-update');
    const read = await service.mutationService.read(command);
    assert.equal(read.authorized, true);
    assert.equal(read.featureDecision.allowed, false);
  });
});

const FAILURE_STAGES = [
  'document',
  'record',
  'first-ws-outbox',
  'second-ws-outbox',
  'result',
  'completion',
] as const;

for (const stage of FAILURE_STAGES) {
  Deno.test(`production AppCrdt transaction rolls back at ${stage}`, async () => {
    await withPGliteSql(async (sql) => {
      const now = await pgliteQueueNow(sql);
      const database = withInjectedTransactionFailure(sql, stage);
      const service = productionService(sql, database, now, true);
      await service.createAndEnqueueAppend({
        update: update(`${stage}-update`, now - 10_000),
        deliveryId: `${stage}-delivery`,
        actor: {
          actorId: 'client-1',
          principalId: 'client-1',
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
      } as never);
      await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
      await service.inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, toResilienceDto());

      const [domain] = await sql<
        { documents: string; updates: string; outbox: string; results: string }[]
      >`
        select
          (select count(*) from crdt_documents)::text as documents,
          (select count(*) from crdt_updates)::text as updates,
          (select count(*) from resource_inbox where ri_type_id = 'WS_OUTBOX')::text as outbox,
          (select count(*) from resource_inbox_results where ris_topic_id = 'app-inbox.crdt-state')::text as results
      `;
      assert.deepEqual(domain, { documents: '0', updates: '0', outbox: '0', results: '0' });
    });
  });
}

Deno.test('production AppCrdt accepts a new session replay and rejects changed-content collision', async () => {
  await withPGliteSql(async (sql) => {
    const now = await pgliteQueueNow(sql);
    const service = productionService(sql, sql, now, true);
    const original = update('shared-update', now - 10_000, 'original');

    await enqueueAndDrain(service, original, 'session-1:delivery-1', 'session-1', now);
    await enqueueAndDrain(service, original, 'session-2:delivery-2', 'session-2', now + 1);
    await enqueueAndDrain(
      service,
      update('shared-update', now - 10_000, 'changed'),
      'session-3:delivery-3',
      'session-3',
      now + 2,
    );

    const [counts] = await sql<{ documents: string; updates: string; outbox: string }[]>`
      select
        (select count(*) from crdt_documents)::text as documents,
        (select count(*) from crdt_updates)::text as updates,
        (select count(*) from resource_inbox where ri_type_id = 'WS_OUTBOX')::text as outbox
    `;
    assert.deepEqual(counts, { documents: '1', updates: '1', outbox: '4' });
    const results = await sql<{ ris_resource: string }[]>`
      select ris_resource from resource_inbox_results
      where ris_topic_id = 'app-inbox.crdt-state'
      order by ris_row_id
    `;
    assert.deepEqual(
      results.map((row) => {
        const result = JSON.parse(row.ris_resource);
        return { status: result.status, code: result.code };
      }),
      [
        { status: 'accepted', code: null },
        { status: 'replay', code: null },
        { status: 'rejected', code: 'duplicate-hash-mismatch' },
      ],
    );
  });
});

Deno.test('production AppInbox retries a CRDT conflict from a fresh revoked authority read', async () => {
  await withPGliteSql(async (sql) => {
    const now = await pgliteQueueNow(sql);
    let allowed = true;
    const database = withOneCrdtConflict(sql, () => {
      allowed = false;
    });
    const service = productionService(sql, database, now, true, () => allowed);

    await enqueueAndDrain(
      service,
      update('revoked-update', now - 10_000),
      'revoked-delivery',
      'session-1',
      now,
    );

    const [counts] = await sql<{ documents: string; updates: string; outbox: string }[]>`
      select
        (select count(*) from crdt_documents)::text as documents,
        (select count(*) from crdt_updates)::text as updates,
        (select count(*) from resource_inbox where ri_type_id = 'WS_OUTBOX')::text as outbox
    `;
    assert.deepEqual(counts, { documents: '0', updates: '0', outbox: '0' });
    const [completion] = await sql<{ ris_status: string; ris_resource: string }[]>`
      select ris_status, ris_resource from resource_inbox_results
      where ris_topic_id = 'app-inbox.crdt-state'
        and ris_resource_id = 'revoked-delivery'
    `;
    assert.equal(completion?.ris_status, 'COMPLETED');
    const result = JSON.parse(completion!.ris_resource);
    assert.equal(result.status, 'rejected');
    assert.equal(result.code, 'authorization-denied');
  });
});

function productionService(
  queueSql: PSqlSql,
  database: PSqlSql,
  now: number,
  allow = false,
  isAllowed: () => boolean = () => true,
) {
  const resourceInbox = new ResourceInboxRepository(queueSql);
  return createApiCrdtInboxService({
    inboxQueueReader: new InboxQueueReader(new PSqlQueueBox(resourceInbox)),
    resourceInboxRepository: resourceInbox,
    resourceInboxResultsRepository: new ResourceInboxResultsRepository(queueSql),
    database,
    serviceId: 'server-1',
    options: { nowEpochMs: () => now },
    currentAuthority: {
      readSession: (sessionId) =>
        Promise.resolve({
          clientId: 'client-1',
          username: 'client-1',
          sessionId,
          expiresAtEpochMs: now + 60_000,
        }),
      authorizeDocument: () =>
        Promise.resolve({
          allowed: isAllowed(),
          code: isAllowed() ? 'allowed' : 'authorization-denied',
        }),
      adminClientIds: ['client-1'],
    },
    policies: allow ? [{ documentType: 'checklist', rollout: 'production' }] : undefined,
  });
}

async function appendCommand(now: number, commandId: string, updateId: string) {
  return await createCrdtMutationCommand({
    operation: 'append',
    commandId,
    actor: {
      actorId: 'client-1',
      principalId: 'client-1',
      sessionId: 'session-1',
      serverId: 'server-1',
    },
    capturedAtEpochMs: now,
    expireAtEpochMs: now + 60_000,
    document: DOCUMENT,
    responseAudience: {
      kind: 'room',
      senderSessionId: 'session-1',
      topicId: 'room.crdt',
      contextId: 'group-1',
    },
    authorizationScope: 'room',
    update: update(updateId, now - 10_000),
  });
}

function update(
  updateId: string,
  createdAtEpochMs: number,
  value = updateId,
): RallarCrdtUpdateEnvelope {
  return {
    protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
    document: DOCUMENT,
    updateId,
    replicaId: 'replica-1',
    lamport: 1,
    parents: [],
    schemaVersion: 1,
    operationVersion: RALLAR_CRDT_OPERATION_VERSION,
    createdAtEpochMs,
    payload: {
      kind: 'batch',
      operations: [{ kind: 'register.set', path: ['title'], policy: 'lww', value }],
    },
  };
}

async function pgliteQueueNow(sql: PGliteSql): Promise<number> {
  return await readPGliteDatabaseEpochMs(sql) + 12 * 60 * 60 * 1_000;
}

async function enqueueAndDrain(
  service: ReturnType<typeof productionService>,
  envelope: RallarCrdtUpdateEnvelope,
  deliveryId: string,
  sessionId: string,
  capturedAtEpochMs: number,
): Promise<void> {
  await service.createAndEnqueueAppend({
    update: envelope,
    deliveryId,
    actor: {
      actorId: 'client-1',
      principalId: 'client-1',
      sessionId,
      serverId: 'server-1',
    },
    responseAudience: {
      kind: 'room',
      senderSessionId: sessionId,
      topicId: 'room.crdt',
      contextId: 'group-1',
    },
    capturedAtEpochMs,
    expireAtEpochMs: capturedAtEpochMs + 60_000,
  });
  await service.inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, toResilienceDto());
}

function withOneCrdtConflict(database: PSqlSql, onConflict: () => void): PSqlSql {
  let injected = false;
  const wrapped =
    ((parts: TemplateStringsArray | readonly unknown[], ...values: unknown[]) =>
      database(parts as never, ...values)) as PSqlSql;
  wrapped.begin = async <T>(write: (transaction: PSqlTransactionSql) => Promise<T>) =>
    await database.begin(async (transaction) => {
      const conflicting =
        ((parts: TemplateStringsArray | readonly unknown[], ...values: unknown[]) => {
          const text = Array.isArray(parts) && 'raw' in parts ? parts.join(' ') : '';
          if (!injected && text.includes('insert into crdt_documents')) {
            injected = true;
            onConflict();
            throw new CrdtMutationConflictError('injected-document');
          }
          return transaction(parts as never, ...values);
        }) as PSqlTransactionSql;
      conflicting.begin = transaction.begin.bind(transaction);
      return await write(conflicting);
    });
  return wrapped;
}

function withInjectedTransactionFailure(
  database: PSqlSql,
  stage: typeof FAILURE_STAGES[number],
): PSqlSql {
  const wrapped =
    ((parts: TemplateStringsArray | readonly unknown[], ...values: unknown[]) =>
      database(parts as never, ...values)) as PSqlSql;
  wrapped.begin = async <T>(write: (transaction: PSqlTransactionSql) => Promise<T>) =>
    await database.begin(async (transaction) => {
      let wsOutboxWrites = 0;
      const failing = ((parts: TemplateStringsArray | readonly unknown[], ...values: unknown[]) => {
        const text = Array.isArray(parts) && 'raw' in parts ? parts.join(' ') : '';
        if (text.includes('insert into resource_inbox') && values.includes('WS_OUTBOX')) {
          wsOutboxWrites += 1;
        }
        const fail = (stage === 'document' && text.includes('insert into crdt_documents')) ||
          (stage === 'record' && text.includes('insert into crdt_updates')) ||
          (stage === 'first-ws-outbox' && wsOutboxWrites === 1) ||
          (stage === 'second-ws-outbox' && wsOutboxWrites === 2) ||
          (stage === 'result' && text.includes('insert into resource_inbox_results')) ||
          (stage === 'completion' && text.includes('update resource_inbox') &&
            text.includes("ri_status = 'RESERVED'"));
        if (fail) throw new Error(`injected ${stage} failure`);
        return transaction(parts as never, ...values);
      }) as PSqlTransactionSql;
      failing.begin = transaction.begin.bind(transaction);
      return await write(failing);
    });
  return wrapped;
}
