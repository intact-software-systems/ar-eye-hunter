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
import { toResilienceDto } from '../../src/middleware-resilience.ts';
import * as routes from '../../src/routes/crdt-admin-routes.ts';
import {
  readPGliteDatabaseEpochMs,
  waitForPGliteQueueRow,
  withPGliteSql,
} from '../db/pglite-auth-test-harness.ts';

const DOCUMENT: RallarCrdtDocumentRef = {
  applicationId: 'app-1', workspaceId: 'workspace-1', scope: 'room',
  documentType: 'checklist', documentId: 'document-1',
  roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' },
};

Deno.test('actual CRDT admin routes preserve compact/lifecycle/erase responses and post-commit audit', async () => {
  await withPGliteSql(async (sql) => {
    const now = await readPGliteDatabaseEpochMs(sql);
    const resourceInbox = new ResourceInboxRepository(sql);
    const results = new ResourceInboxResultsRepository(sql);
    const inbox = new InboxQueueReader(new PSqlQueueBox(resourceInbox));
    const mutationService = createCrdtMutationService({
      repository: new PSqlCrdtMutationRepository(sql, () => Promise.resolve(true)),
      createWriter: (transaction) => new PSqlCrdtMutationRepository(
        transaction,
        () => Promise.resolve(true),
      ),
      serviceId: 'server-1',
    });
    const initial = await createCrdtMutationCommand({
      operation: 'append', commandId: 'initial',
      actor: { actorId: 'admin', principalId: 'admin', sessionId: 'admin-session', serverId: 'server-1' },
      capturedAtEpochMs: now, expireAtEpochMs: now + 60_000,
      document: DOCUMENT, update: update(now), authorizationScope: 'room',
      responseAudience: { kind: 'room', senderSessionId: 'admin-session', topicId: 'room.crdt', contextId: 'group-1' },
    });
    const initialRead = await mutationService.read(initial);
    const initialComputed = mutationService.compute(initial, initialRead);
    await sql.begin(async (transaction) => await mutationService.write(transaction, initialComputed));

    const audit: RallarCrdtAuditEvent[] = [];
    const appCrdt = new (AppCrdtInboxService as never as new (...args: unknown[]) => AppCrdtInboxService)(
      inbox, resourceInbox, results, sql, mutationService, 'server-1', undefined,
      {
        waitMaxElapsedMsecs: 5_000, waitRetryIntervalMsecs: 1,
        waitMaxRetryIntervalMsecs: 4, waitJitterRatio: 0, nowEpochMs: () => now + 1,
      },
      { audit: { record: (event: RallarCrdtAuditEvent) => { audit.push(event); } } },
    );
    const app = new Hono();
    routes.init(app, {
      repository: new PSqlCrdtLogRepository(sql),
      mutations: appCrdt,
      requireAuth: false,
      requireApiAdminSession: () => Promise.resolve({
        clientId: 'admin', username: 'admin', sessionId: 'admin-session', accessToken: 'token',
        expiresAtEpochMs: now + 60_000,
      }),
    });

    const compact = await postAndProcess(app, inbox, sql,
      '/api/crdt/admin/documents/compact', {
        requestId: 'compact-route', document: DOCUMENT, reason: 'compact-route',
      });
    assert.equal(compact.ok, true);
    assert.equal(compact.result.appendSequence, 1);
    assert.equal(compact.result.snapshot.document.documentId, DOCUMENT.documentId);

    const lifecycle = await postAndProcess(app, inbox, sql,
      '/api/crdt/admin/documents/lifecycle', {
        requestId: 'lifecycle-route', document: DOCUMENT, lifecycle: 'archived',
      });
    assert.equal(lifecycle.result.lifecycle, 'archived');
    assert.equal(lifecycle.result.documentKey, initial.documentKey);

    const erase = await postAndProcess(app, inbox, sql,
      '/api/crdt/admin/documents/erase', {
        requestId: 'erase-route', document: DOCUMENT, mode: 'destroy-document', reason: 'privacy',
      });
    assert.equal(erase.result.request.mode, 'destroy-document');
    assert.equal(erase.result.auditEvent.kind, 'erase');
    assert.equal(erase.result.metadata.lifecycle, 'destroyed');
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.kind, 'erase');
  });
});

async function postAndProcess(
  app: Hono,
  inbox: InboxQueueReader,
  sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0],
  path: string,
  body: unknown,
): Promise<any> {
  const responsePending = app.request(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
  await inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, toResilienceDto());
  return await (await responsePending).json();
}

function update(now: number): RallarCrdtUpdateEnvelope {
  return {
    protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION, document: DOCUMENT,
    updateId: 'initial-update', replicaId: 'replica-1', lamport: 1,
    parents: [], schemaVersion: 1, operationVersion: RALLAR_CRDT_OPERATION_VERSION,
    createdAtEpochMs: now,
    payload: { kind: 'batch', operations: [{ kind: 'register.set', path: ['title'], policy: 'lww', value: 'initial' }] },
  };
}
