import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';

import {
  RALLAR_CRDT_OPERATION_VERSION,
  RALLAR_CRDT_PROTOCOL_VERSION,
  type RallarCrdtAdminReadRepository,
  type RallarCrdtAuditEvent,
  type RallarCrdtDocumentRef,
  type RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
// deno-fmt-ignore
import { PSqlCrdtLogRepository } from '@shared-server/rallar-system/crdt/persistence/\
psql-crdt-log-repository.ts';
// deno-fmt-ignore
import { PSqlCrdtMutationRepository } from '@shared-server/rallar-system/crdt/persistence/\
psql-crdt-mutation-repository.ts';
// deno-fmt-ignore
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/\
ResourceInboxRepository.ts';
// deno-fmt-ignore
import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/\
ResourceInboxResultsRepository.ts';
// deno-fmt-ignore
import { AppCrdtInboxService } from '@shared-server/rallar-system/crdt/inbox/\
app-crdt-inbox-service.ts';
// deno-fmt-ignore
import { createCrdtMutationService } from '@shared-server/rallar-system/crdt/mutation/\
create-crdt-mutation-service.ts';
// deno-fmt-ignore
import { createCrdtMutationCommand } from '@shared-server/rallar-system/crdt/mutation/\
crdt-mutation-command-codec.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';

import { toResilienceDto } from '../../../src/middleware-resilience.ts';
import { createCrdtAdminMutations } from '../../../src/crdt/create-crdt-admin-mutations.ts';
import * as routes from '../../../src/crdt/register-crdt-admin-routes.ts';
import { waitForPGliteQueueRow, withPGliteSql } from '../../db/pglite-auth-test-harness.ts';

const DOCUMENT: RallarCrdtDocumentRef = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
  scope: 'room',
  documentType: 'checklist',
  documentId: 'document-1',
  roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' },
};

interface SqlCountRow {
  readonly count: string | number;
}

interface MutationCountsRow {
  readonly revision: string | number;
  readonly snapshots: string | number;
  readonly updates: string | number;
  readonly outbox: string | number;
}

interface PostAndProcessRawResult {
  readonly response: Response;
  readonly body: Record<string, unknown>;
}

Deno.test(
  'actual CRDT admin routes preserve compact/lifecycle/erase responses and post-commit audit',
  async () => await withPGliteSql(verifyCrdtAdminResponseCompatibility),
);

interface CrdtAdminRouteHarness {
  readonly app: Hono;
  readonly audit: readonly RallarCrdtAuditEvent[];
  readonly documentKey: string;
  readonly inbox: InboxQueueReader;
  readonly outbox: OutboxQueueReader;
  readonly readAuditAttempts: () => number;
  readonly sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0];
}

interface CreateAdminAppCrdtInput {
  readonly audit: RallarCrdtAuditEvent[];
  readonly inbox: InboxQueueReader;
  readonly mutationService: ReturnType<typeof createCrdtMutationService>;
  readonly now: number;
  readonly outbox: OutboxQueueReader;
  readonly readAuditAttempts: () => number;
  readonly recordAuditAttempt: () => void;
  readonly resourceInbox: ResourceInboxRepository;
  readonly results: ResourceInboxResultsRepository;
  readonly sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0];
}

async function verifyCrdtAdminResponseCompatibility(
  sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0],
): Promise<void> {
  const harness = await createCrdtAdminRouteHarness(sql);
  await verifyMissingDocumentResponse(harness);
  await verifyQuotaRejectionResponse(harness);
  await verifyCompactResponse(harness);
  await verifyLifecycleResponse(harness);
  await verifyEraseResponseAndAuditDelivery(harness);
}

async function createCrdtAdminRouteHarness(
  sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0],
): Promise<CrdtAdminRouteHarness> {
  const now = Date.now() + 12 * 60 * 60 * 1_000;
  const resourceInbox = new ResourceInboxRepository(sql);
  const results = new ResourceInboxResultsRepository(sql);
  const queue = new PSqlQueueBox(resourceInbox);
  const inbox = new InboxQueueReader(queue);
  const outbox = new OutboxQueueReader(queue);
  const mutationService = createTestCrdtMutationService(sql);
  const documentKey = await seedCrdtAdminDocument(sql, mutationService, now);
  const audit: RallarCrdtAuditEvent[] = [];
  let auditAttempts = 0;
  const appCrdt = createAdminAppCrdt({
    audit,
    inbox,
    mutationService,
    now,
    outbox,
    readAuditAttempts: () => auditAttempts,
    recordAuditAttempt: () => {
      auditAttempts += 1;
    },
    resourceInbox,
    results,
    sql,
  });
  return {
    app: createCrdtAdminApp(sql, appCrdt, now),
    audit,
    documentKey,
    inbox,
    outbox,
    readAuditAttempts: () => auditAttempts,
    sql,
  };
}

function createTestCrdtMutationService(
  sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0],
): ReturnType<typeof createCrdtMutationService> {
  return createCrdtMutationService({
    repository: new PSqlCrdtMutationRepository(
      { sql, authorize: () => Promise.resolve(true) },
      { policies: [] },
    ),
    createWriter: (transaction) =>
      new PSqlCrdtMutationRepository(
        { sql: transaction, authorize: () => Promise.resolve(true) },
        { policies: [] },
      ),
    serviceId: 'server-1',
  });
}

async function seedCrdtAdminDocument(
  sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0],
  mutationService: ReturnType<typeof createCrdtMutationService>,
  now: number,
): Promise<string> {
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
  const read = await mutationService.read(initial);
  const computed = mutationService.compute({ command: initial, read });
  await sql.begin(async (transaction) => await mutationService.write(transaction, computed));
  await sql`
    update crdt_documents set
      retention_policy = ${JSON.stringify({ mode: 'retain', reason: 'existing' })},
      quota_policy = ${JSON.stringify({ maxDocumentBytes: 100000 })},
      projection_ids = ${JSON.stringify(['existing-projection'])}
    where document_key = ${initial.documentKey}
  `;
  return initial.documentKey;
}

function createAdminAppCrdt(input: CreateAdminAppCrdtInput): AppCrdtInboxService {
  const auditSink = {
    record: (event: RallarCrdtAuditEvent) => {
      input.recordAuditAttempt();
      if (input.readAuditAttempts() === 1) {
        throw new Error('audit sink unavailable');
      }
      input.audit.push(event);
    },
  };
  return new AppCrdtInboxService(
    {
      inboxQueueReader: input.inbox,
      resourceInboxRepository: input.resourceInbox,
      resourceInboxResultsRepository: input.results,
      database: input.sql,
      mutationService: input.mutationService,
      readCurrentSession: () => Promise.reject(new Error('not read')),
      wakeQueueEngine: () => undefined,
      auditDelivery: { auditSink, outboxQueueReader: input.outbox },
    },
    {
      serviceId: 'server-1',
      timing: undefined,
      appInbox: {
        waitMaxElapsedMsecs: 5_000,
        waitRetryIntervalMsecs: 1,
        waitMaxRetryIntervalMsecs: 4,
        waitJitterRatio: 0,
        nowEpochMs: () => input.now + 1,
      },
    },
  );
}

function createCrdtAdminApp(
  sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0],
  appCrdt: AppCrdtInboxService,
  now: number,
): Hono {
  const app = new Hono();
  routes.registerCrdtAdminRoutes(app, {
    repository: new PSqlCrdtLogRepository(sql),
    crdtAdminMutations: createCrdtAdminMutations({
      appCrdtInboxService: appCrdt,
      nowEpochMs: () => now + 1,
      createId: () => crypto.randomUUID(),
      serviceId: 'server-1',
    }),
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
  return app;
}

async function verifyMissingDocumentResponse(harness: CrdtAdminRouteHarness): Promise<void> {
  const missing = await postAndProcessRaw({
    ...harness,
    path: '/api/crdt/admin/documents/compact',
    body: {
      requestId: 'missing-route',
      document: { ...DOCUMENT, documentId: 'missing-document' },
      reason: 'missing-route',
    },
  });
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.ok, false);
}

async function verifyQuotaRejectionResponse(harness: CrdtAdminRouteHarness): Promise<void> {
  await harness.sql`
    update crdt_documents
    set quota_policy = ${JSON.stringify({ maxDocumentBytes: 1 })}
    where document_key = ${harness.documentKey}
  `;
  const before = await mutationCounts(harness.sql, harness.documentKey);
  const rejected = await postAndProcessRaw({
    ...harness,
    path: '/api/crdt/admin/documents/compact',
    body: {
      requestId: 'quota-rejected-route',
      document: DOCUMENT,
      reason: 'quota-rejected-route',
    },
  });
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.body.ok, false);
  assert.deepEqual(await mutationCounts(harness.sql, harness.documentKey), before);
  await harness.sql`
    update crdt_documents
    set quota_policy = ${JSON.stringify({ maxDocumentBytes: 100000 })}
    where document_key = ${harness.documentKey}
  `;
}

async function verifyCompactResponse(harness: CrdtAdminRouteHarness): Promise<void> {
  const compact = await postAndProcess({
    ...harness,
    path: '/api/crdt/admin/documents/compact',
    body: {
      requestId: 'compact-route',
      document: DOCUMENT,
      reason: 'compact-route',
    },
  });
  assert.equal(compact.ok, true);
  const result = requireRecord(compact.result, 'compact result');
  const snapshot = requireRecord(result.snapshot, 'compact snapshot');
  const document = requireRecord(snapshot.document, 'compact snapshot document');
  assert.equal(result.appendSequence, 1);
  assert.equal(document.documentId, DOCUMENT.documentId);
}

async function verifyLifecycleResponse(harness: CrdtAdminRouteHarness): Promise<void> {
  const lifecycle = await postAndProcess({
    ...harness,
    path: '/api/crdt/admin/documents/lifecycle',
    body: {
      requestId: 'lifecycle-route',
      document: DOCUMENT,
      lifecycle: 'archived',
    },
  });
  const result = requireRecord(lifecycle.result, 'lifecycle result');
  assert.equal(result.lifecycle, 'archived');
  assert.equal(result.documentKey, harness.documentKey);
  assert.deepEqual(result.retention, { mode: 'retain', reason: 'existing' });
  assert.deepEqual(result.quota, { maxDocumentBytes: 100000 });
  assert.deepEqual(result.projectionIds, ['existing-projection']);
}

async function verifyEraseResponseAndAuditDelivery(
  harness: CrdtAdminRouteHarness,
): Promise<void> {
  const erase = await postAndProcess({
    ...harness,
    path: '/api/crdt/admin/documents/erase',
    body: {
      requestId: 'erase-route',
      document: DOCUMENT,
      mode: 'destroy-document',
      reason: 'privacy',
    },
  });
  const result = requireRecord(erase.result, 'erase result');
  assert.equal(requireRecord(result.request, 'erase request').mode, 'destroy-document');
  assert.equal(requireRecord(result.auditEvent, 'erase audit event').kind, 'erase');
  assert.equal(requireRecord(result.metadata, 'erase metadata').lifecycle, 'destroyed');
  assert.equal(harness.audit.length, 0);
  assert.equal(await readAuditCount(harness.sql, "ri_status = 'NEW'"), 1);
  await waitForPGliteQueueRow(harness.sql, 'APP_OUTBOX', 'NEW');
  await harness.outbox.dequeueOutbox(
    OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
    toResilienceDto(),
  );
  assert.equal(harness.readAuditAttempts(), 2);
  assert.equal(harness.audit.length, 1);
  assert.equal(await readAuditCount(harness.sql, "ri_status = 'COMPLETED'"), 1);
}

async function readAuditCount(
  sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0],
  statusPredicate: "ri_status = 'NEW'" | "ri_status = 'COMPLETED'",
): Promise<number> {
  const rows = statusPredicate === "ri_status = 'NEW'"
    ? await sql<SqlCountRow[]>`
      select count(*) as count from resource_inbox
      where ri_type_id = 'APP_OUTBOX' and ri_status = 'NEW'
    `
    : await sql<SqlCountRow[]>`
      select count(*) as count from resource_inbox
      where ri_type_id = 'APP_OUTBOX' and ri_status = 'COMPLETED'
    `;
  return Number(rows[0]?.count);
}

Deno.test('actual CRDT admin Hono routes preserve 401 and 403 denials', async () => {
  const unauthorized = new Hono();
  routes.registerCrdtAdminRoutes(unauthorized, {
    repository: createUnusedCrdtReadRepository(),
    crdtAdminMutations: {
      writeCrdtAdminMutation: () => {
        throw new Error('mutation must not run');
      },
    },
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
  assert.equal((await readJsonRecord(unauthorizedResponse)).ok, false);

  const forbidden = new Hono();
  routes.registerCrdtAdminRoutes(forbidden, {
    repository: createUnusedCrdtReadRepository(),
    crdtAdminMutations: {
      writeCrdtAdminMutation: () => {
        throw new Error('mutation must not run');
      },
    },
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
  assert.equal((await readJsonRecord(forbiddenResponse)).ok, false);
});

function createUnusedCrdtReadRepository(): RallarCrdtAdminReadRepository {
  const unused = () => Promise.reject(new Error('CRDT read operation is unused'));
  return {
    listAfter: unused,
    readSnapshot: unused,
    readDocumentMetadata: unused,
    listDocuments: unused,
    exportDebugBundle: unused,
    exportBackupBundle: unused,
    verifyIntegrity: unused,
  };
}

async function mutationCounts(
  sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0],
  documentKey: string,
) {
  const [counts] = await sql<MutationCountsRow[]>`
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
  if (!counts) {
    throw new Error('CRDT mutation counts are missing');
  }
  return {
    revision: Number(counts.revision),
    snapshots: Number(counts.snapshots),
    updates: Number(counts.updates),
    outbox: Number(counts.outbox),
  };
}

interface PostAndProcessInput {
  readonly app: Hono;
  readonly inbox: InboxQueueReader;
  readonly sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0];
  readonly path: string;
  readonly body: unknown;
}

async function postAndProcess(
  input: PostAndProcessInput,
): Promise<Record<string, unknown>> {
  const { app, inbox, sql, path, body } = input;
  const responsePending = app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
  await inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, toResilienceDto());
  return await readJsonRecord(await responsePending);
}

async function postAndProcessRaw(
  input: PostAndProcessInput,
): Promise<PostAndProcessRawResult> {
  const { app, inbox, sql, path, body } = input;
  const responsePending = app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
  await inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, toResilienceDto());
  const response = await responsePending;
  return { response, body: await readJsonRecord(response) };
}

async function readJsonRecord(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  return requireRecord(value, 'CRDT admin response');
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
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
