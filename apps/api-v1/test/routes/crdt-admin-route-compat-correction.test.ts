import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import {
  RALLAR_CRDT_OPERATION_VERSION,
  RALLAR_CRDT_PROTOCOL_VERSION,
  type RallarCrdtAuditEvent,
  type RallarCrdtDocumentRef,
  type RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import { PSqlCrdtLogRepository } from '@shared-server/postgres/crdt/PSqlCrdtLogRepository.ts';
import { PSqlCrdtMutationRepository } from '@shared-server/postgres/crdt/PSqlCrdtMutationRepository.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { AppCrdtInboxService } from '@shared-server/rallar-system/services/AppCrdtInboxService.ts';
import {
  createCrdtMutationCommand,
  createCrdtMutationService,
} from '@shared-server/rallar-system/services/crdt-mutations.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { toResilienceDto } from '../../src/middleware-resilience.ts';
import * as routes from '../../src/routes/crdt-admin-routes.ts';
import { waitForPGliteQueueRow, withPGliteSql } from '../db/pglite-auth-test-harness.ts';

const DOCUMENT: RallarCrdtDocumentRef = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
  scope: 'room',
  documentType: 'checklist',
  documentId: 'document-1',
  roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' },
};

Deno.test('actual CRDT admin routes preserve compact/lifecycle/erase responses and post-commit audit', async () => {
  await withPGliteSql(async (sql) => {
    // PGlite's timestamp-without-zone comparison follows the host offset in this suite.
    const now = Date.now() + 12 * 60 * 60 * 1_000;
    const resourceInbox = new ResourceInboxRepository(sql);
    const results = new ResourceInboxResultsRepository(sql);
    const queue = new PSqlQueueBox(resourceInbox);
    const inbox = new InboxQueueReader(queue);
    const outbox = new OutboxQueueReader(queue);
    const mutationService = createCrdtMutationService({
      repository: new PSqlCrdtMutationRepository(sql, () => Promise.resolve(true)),
      createWriter: (transaction) =>
        new PSqlCrdtMutationRepository(
          transaction,
          () => Promise.resolve(true),
        ),
      serviceId: 'server-1',
    });
    const initial = await createCrdtMutationCommand({
      operation: 'append',
      commandId: 'initial',
      actor: {
        actorId: 'admin',
        principalId: 'admin',
        sessionId: 'admin-session',
        serverId: 'server-1',
      },
      capturedAtEpochMs: now,
      expireAtEpochMs: now + 60_000,
      document: DOCUMENT,
      update: update(now),
      authorizationScope: 'room',
      responseAudience: {
        kind: 'room',
        senderSessionId: 'admin-session',
        topicId: 'room.crdt',
        contextId: 'group-1',
      },
    });
    const initialRead = await mutationService.read(initial);
    const initialComputed = mutationService.compute(initial, initialRead);
    await sql.begin(async (transaction) =>
      await mutationService.write(transaction, initialComputed)
    );
    await sql`
      update crdt_documents set
        retention_policy = ${JSON.stringify({ mode: 'retain', reason: 'existing' })},
        quota_policy = ${JSON.stringify({ maxDocumentBytes: 100000 })},
        projection_ids = ${JSON.stringify(['existing-projection'])}
      where document_key = ${initial.documentKey}
    `;

    const audit: RallarCrdtAuditEvent[] = [];
    let auditAttempts = 0;
    const appCrdt =
      new (AppCrdtInboxService as never as new (...args: unknown[]) => AppCrdtInboxService)(
        inbox,
        resourceInbox,
        results,
        sql,
        mutationService,
        'server-1',
        undefined,
        {
          waitMaxElapsedMsecs: 5_000,
          waitRetryIntervalMsecs: 1,
          waitMaxRetryIntervalMsecs: 4,
          waitJitterRatio: 0,
          nowEpochMs: () => now + 1,
        },
        {
          audit: {
            record: (event: RallarCrdtAuditEvent) => {
              auditAttempts += 1;
              if (auditAttempts === 1) throw new Error('audit sink unavailable');
              audit.push(event);
            },
          },
          outboxQueueReader: outbox,
        },
      );
    const app = new Hono();
    routes.registerCrdtAdminRoutes(app, {
      repository: new PSqlCrdtLogRepository(sql),
      mutations: appCrdt,
      requireAuth: false,
      requireApiAdminSession: () =>
        Promise.resolve({
          clientId: 'admin',
          username: 'admin',
          sessionId: 'admin-session',
          accessToken: 'token',
          issuedAtEpochMs: now,
          expiresAtEpochMs: now + 60_000,
        }),
      requireApiUserSession: () => Promise.reject(new Error('unused')),
    });

    const missing = await postAndProcessRaw(app, inbox, sql, '/api/crdt/admin/documents/compact', {
      requestId: 'missing-route',
      document: { ...DOCUMENT, documentId: 'missing-document' },
      reason: 'missing-route',
    });
    assert.equal(missing.response.status, 404);
    assert.equal(missing.body.ok, false);

    await sql`
      update crdt_documents
      set quota_policy = ${JSON.stringify({ maxDocumentBytes: 1 })}
      where document_key = ${initial.documentKey}
    `;
    const beforeQuotaRejection = await mutationCounts(sql, initial.documentKey);
    const quotaRejected = await postAndProcessRaw(
      app,
      inbox,
      sql,
      '/api/crdt/admin/documents/compact',
      {
        requestId: 'quota-rejected-route',
        document: DOCUMENT,
        reason: 'quota-rejected-route',
      },
    );
    assert.equal(quotaRejected.response.status, 409);
    assert.equal(quotaRejected.body.ok, false);
    assert.deepEqual(
      await mutationCounts(sql, initial.documentKey),
      beforeQuotaRejection,
    );
    await sql`
      update crdt_documents
      set quota_policy = ${JSON.stringify({ maxDocumentBytes: 100000 })}
      where document_key = ${initial.documentKey}
    `;

    const compact = await postAndProcess<{
      ok: boolean;
      result: {
        appendSequence: number;
        snapshot: { document: { documentId: string } };
      };
    }>(app, inbox, sql, '/api/crdt/admin/documents/compact', {
      requestId: 'compact-route',
      document: DOCUMENT,
      reason: 'compact-route',
    });
    assert.equal(compact.ok, true);
    assert.equal(compact.result.appendSequence, 1);
    assert.equal(compact.result.snapshot.document.documentId, DOCUMENT.documentId);

    const lifecycle = await postAndProcess<{
      result: {
        lifecycle: string;
        documentKey: string;
        retention: unknown;
        quota: unknown;
        projectionIds: string[];
      };
    }>(app, inbox, sql, '/api/crdt/admin/documents/lifecycle', {
      requestId: 'lifecycle-route',
      document: DOCUMENT,
      lifecycle: 'archived',
    });
    assert.equal(lifecycle.result.lifecycle, 'archived');
    assert.equal(lifecycle.result.documentKey, initial.documentKey);
    assert.deepEqual(lifecycle.result.retention, { mode: 'retain', reason: 'existing' });
    assert.deepEqual(lifecycle.result.quota, { maxDocumentBytes: 100000 });
    assert.deepEqual(lifecycle.result.projectionIds, ['existing-projection']);

    const erase = await postAndProcess<{
      result: {
        request: { mode: string };
        auditEvent: { kind: string };
        metadata: { lifecycle: string };
      };
    }>(app, inbox, sql, '/api/crdt/admin/documents/erase', {
      requestId: 'erase-route',
      document: DOCUMENT,
      mode: 'destroy-document',
      reason: 'privacy',
    });
    assert.equal(erase.result.request.mode, 'destroy-document');
    assert.equal(erase.result.auditEvent.kind, 'erase');
    assert.equal(erase.result.metadata.lifecycle, 'destroyed');
    assert.equal(audit.length, 0);
    const [durableAudit] = await sql<{ count: string | number }[]>`
      select count(*) as count from resource_inbox where ri_type_id = 'APP_OUTBOX'
    `;
    assert.equal(Number(durableAudit?.count), 1);
    await waitForPGliteQueueRow(sql, 'APP_OUTBOX', 'NEW');
    await outbox.dequeueOutbox(
      OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
      toResilienceDto(),
    );
    assert.equal(auditAttempts, 2);
    assert.equal(audit.length, 1);
    const [completedAudit] = await sql<{ count: string | number }[]>`
      select count(*) as count from resource_inbox
      where ri_type_id = 'APP_OUTBOX' and ri_status = 'COMPLETED'
    `;
    assert.equal(Number(completedAudit?.count), 1);
  });
});

Deno.test('actual CRDT admin Hono routes preserve 401 and 403 denials', async () => {
  const unauthorized = new Hono();
  routes.registerCrdtAdminRoutes(unauthorized, {
    repository: {} as never,
    mutations: {
      processAdminMutationUntilCompletion: () => {
        throw new Error('mutation must not run');
      },
    } as never,
    requireAuth: false,
    requireApiAdminSession: () => {
      throw Object.assign(new Error('Unauthorized: expired session'), { status: 401 });
    },
    requireApiUserSession: () => Promise.reject(new Error('unused')),
  });
  const unauthorizedResponse = await unauthorized.request(
    '/api/crdt/admin/documents/compact',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ document: DOCUMENT }),
    },
  );
  assert.equal(unauthorizedResponse.status, 401);
  assert.equal((await unauthorizedResponse.json()).ok, false);

  const forbidden = new Hono();
  routes.registerCrdtAdminRoutes(forbidden, {
    repository: {} as never,
    mutations: {
      processAdminMutationUntilCompletion: () => {
        throw new Error('mutation must not run');
      },
    } as never,
    requireAuth: false,
    requireApiAdminSession: () =>
      Promise.resolve({
        clientId: 'non-admin',
        username: 'non-admin',
        sessionId: 'session-1',
        accessToken: 'token',
        issuedAtEpochMs: Date.now(),
        expiresAtEpochMs: Date.now() + 60_000,
      }),
    requireApiUserSession: () => Promise.reject(new Error('unused')),
    authorizeAdmin: () => false,
  });
  const forbiddenResponse = await forbidden.request(
    '/api/crdt/admin/documents/compact',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ document: DOCUMENT }),
    },
  );
  assert.equal(forbiddenResponse.status, 403);
  assert.equal((await forbiddenResponse.json()).ok, false);
});

async function mutationCounts(
  sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0],
  documentKey: string,
) {
  const [counts] = await sql<{
    revision: string | number;
    snapshots: string | number;
    updates: string | number;
    outbox: string | number;
  }[]>`
      select
        (select document_revision from crdt_documents where document_key = ${documentKey})
          as revision,
        (select count(*) from crdt_snapshots where document_key = ${documentKey})
          as snapshots,
        (select count(*) from crdt_updates where document_key = ${documentKey})
          as updates,
        (select count(*) from resource_inbox where ri_type_id in ('WS_OUTBOX', 'APP_OUTBOX'))
          as outbox
    `;
  return {
    revision: Number(counts!.revision),
    snapshots: Number(counts!.snapshots),
    updates: Number(counts!.updates),
    outbox: Number(counts!.outbox),
  };
}

async function postAndProcess<T>(
  app: Hono,
  inbox: InboxQueueReader,
  sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0],
  path: string,
  body: unknown,
): Promise<T> {
  const responsePending = app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
  await inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, toResilienceDto());
  return await (await responsePending).json() as T;
}

async function postAndProcessRaw<T extends object = { ok: boolean }>(
  app: Hono,
  inbox: InboxQueueReader,
  sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0],
  path: string,
  body: unknown,
): Promise<{ response: Response; body: T }> {
  const responsePending = app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
  await inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, toResilienceDto());
  const response = await responsePending;
  return { response, body: await response.json() as T };
}

function update(now: number): RallarCrdtUpdateEnvelope {
  return {
    protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
    document: DOCUMENT,
    updateId: 'initial-update',
    replicaId: 'replica-1',
    lamport: 1,
    parents: [],
    schemaVersion: 1,
    operationVersion: RALLAR_CRDT_OPERATION_VERSION,
    createdAtEpochMs: now,
    payload: {
      kind: 'batch',
      operations: [{ kind: 'register.set', path: ['title'], policy: 'lww', value: 'initial' }],
    },
  };
}
