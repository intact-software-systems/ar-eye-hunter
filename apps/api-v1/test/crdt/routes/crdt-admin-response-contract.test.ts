import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import {
    RALLAR_CRDT_OPERATION_VERSION,
    RALLAR_CRDT_PROTOCOL_VERSION,
    type RallarCrdtAdminReadRepository,
    type RallarCrdtAuditEvent,
    type RallarCrdtDocumentRef,
    type RallarCrdtUpdateEnvelope
} from '@shared/crdt/mod.ts';

import { PSqlCrdtLogRepository } from '@shared-server/rallar-system/crdt/persistence/psql-crdt-log-repository.ts';

import { PSqlCrdtMutationRepository } from '@shared-server/rallar-system/crdt/persistence/psql-crdt-mutation-repository.ts';

import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';

import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';

import { AppCrdtInboxService } from '@shared-server/rallar-system/crdt/inbox/app-crdt-inbox-service.ts';

import { createCrdtMutationService } from '@shared-server/rallar-system/crdt/mutation/create-crdt-mutation-service.ts';

import { createCrdtMutationCommand } from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-command-codec.ts';
import type { JsonWireObject, JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';

import { createCrdtAdminMutations } from '../../../src/crdt/create-crdt-admin-mutations.ts';
import * as routes from '../../../src/crdt/register-crdt-admin-routes.ts';
import { toResilienceDto } from '../../api-v1-test-queue-resilience.ts';
import { waitForPGliteQueueRow, withPGliteSql } from '../../db/pglite-auth-test-harness.ts';

const DOCUMENT: RallarCrdtDocumentRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    scope: 'room',
    documentType: 'checklist',
    documentId: 'document-1',
    roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' }
};

const DOCUMENT_WIRE: JsonWireObject = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    scope: 'room',
    documentType: 'checklist',
    documentId: 'document-1',
    roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' }
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

interface AppInboxPersistenceRow {
    readonly inbox_count: string | number;
    readonly inbox_status: string | null;
    readonly result_count: string | number;
    readonly result_status: string | null;
}

interface PostAndProcessRawResult {
    readonly response: Response;
    readonly body: JsonWireObject;
}

Deno.test(
    'actual CRDT admin routes preserve compact/lifecycle/erase responses and post-commit audit',
    async () => await withPGliteSql(verifyCrdtAdminResponseContract)
);

interface CrdtAdminRouteHarness {
    readonly app: Hono;
    readonly audit: readonly RallarCrdtAuditEvent[];
    readonly documentKey: string;
    readonly inbox: InboxQueueReader;
    readonly outbox: OutboxQueueReader;
    readonly readAuditAttempts: () => number;
    readonly readMaterializationCounts: () => Readonly<{ clocks: number; ids: number; }>;
    readonly sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0];
    readonly appForSession: (session: IssuedAdminSession) => Hono;
}

interface IssuedAdminSession {
    readonly clientId: string;
    readonly username: string;
    readonly sessionId: string;
    readonly accessToken: string;
    readonly issuedAtEpochMs: number;
    readonly expiresAtEpochMs: number;
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

async function verifyCrdtAdminResponseContract(
    sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0]
): Promise<void> {
    const harness = await createCrdtAdminRouteHarness(sql);
    await verifyMissingDocumentResponse(harness);
    await verifyQuotaRejectionResponse(harness);
    await verifyStrictCrdtHttpIdempotency(harness);
    await verifyCompactResponse(harness);
    await verifyLifecycleResponse(harness);
    await verifyEraseResponseAndAuditDelivery(harness);
}

async function createCrdtAdminRouteHarness(
    sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0]
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
    let materializedClocks = 0;
    let materializedIds = 0;
    const nowEpochMs = () => {
        materializedClocks += 1;
        return now + 1;
    };
    const createId = () => {
        materializedIds += 1;
        return crypto.randomUUID();
    };
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
        sql
    });
    return {
        app: createCrdtAdminApp(sql, appCrdt, now, nowEpochMs, createId),
        appForSession: (session) => createCrdtAdminApp(sql, appCrdt, now, nowEpochMs, createId, session),
        audit,
        documentKey,
        inbox,
        outbox,
        readAuditAttempts: () => auditAttempts,
        readMaterializationCounts: () => ({ clocks: materializedClocks, ids: materializedIds }),
        sql
    };
}

function createTestCrdtMutationService(
    sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0]
): ReturnType<typeof createCrdtMutationService> {
    return createCrdtMutationService({
        repository: new PSqlCrdtMutationRepository(
            { sql, authorize: () => Promise.resolve(true) },
            { policies: [] }
        ),
        createWriter: (transaction) =>
            new PSqlCrdtMutationRepository(
                { sql: transaction, authorize: () => Promise.resolve(true) },
                { policies: [] }
            ),
        serviceId: 'server-1'
    });
}

async function seedCrdtAdminDocument(
    sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0],
    mutationService: ReturnType<typeof createCrdtMutationService>,
    now: number
): Promise<string> {
    const initial = await createCrdtMutationCommand({
        operation: 'append',
        commandId: 'initial',
        actor: {
            actorId: 'admin',
            principalId: 'admin',
            sessionId: 'admin-session',
            serverId: 'server-1'
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
            contextId: 'group-1'
        }
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
        }
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
            auditDelivery: { auditSink, outboxQueueReader: input.outbox }
        },
        {
            serviceId: 'server-1',
            timing: undefined,
            appInbox: {
                waitMaxElapsedMsecs: 5_000,
                waitRetryIntervalMsecs: 1,
                waitMaxRetryIntervalMsecs: 4,
                waitJitterRatio: 0,
                nowEpochMs: () => input.now + 1
            }
        }
    );
}

function createCrdtAdminApp(
    sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0],
    appCrdt: AppCrdtInboxService,
    now: number,
    nowEpochMs: () => number,
    createId: () => string,
    session: IssuedAdminSession = {
        clientId: 'admin',
        username: 'admin',
        sessionId: 'admin-session',
        accessToken: 'token',
        issuedAtEpochMs: now,
        expiresAtEpochMs: now + 60_000
    }
): Hono {
    const app = new Hono();
    routes.registerCrdtAdminRoutes(app, {
        repository: new PSqlCrdtLogRepository(sql),
        crdtAdminMutations: createCrdtAdminMutations({
            appCrdtInboxService: appCrdt,
            nowEpochMs,
            createId,
            serviceId: 'server-1'
        }),
        requireAuth: false,
        requireApiAdminSession: () => Promise.resolve(session),
        requireApiUserSession: () => Promise.reject(new Error('unused'))
    });
    return app;
}

async function verifyMissingDocumentResponse(harness: CrdtAdminRouteHarness): Promise<void> {
    const missing = await postAndProcessRaw({
        ...harness,
        path: '/api/crdt/admin/documents/compact/requests/missing-route-request',
        body: {
            document: { ...DOCUMENT_WIRE, documentId: 'missing-document' },
            reason: 'missing-route'
        }
    });
    assert.equal(missing.response.status, 404);
    assert.equal(missing.body.type, 'api-mutation-failure');
    assert.equal(missing.body.version, 'canonical.v2');
}

async function verifyQuotaRejectionResponse(harness: CrdtAdminRouteHarness): Promise<void> {
    await harness.sql`
    update crdt_documents
    set quota_policy = ${JSON.stringify({ maxDocumentBytes: 1 })}
    where document_key = ${harness.documentKey}
  `;
    const before = await mutationCounts(harness.sql, harness.documentKey);
    const path = '/api/crdt/admin/documents/compact/requests/quota-rejected-route';
    const request = {
        document: DOCUMENT_WIRE,
        reason: 'quota-rejected-route'
    };
    const rejected = await postAndProcessRaw({
        ...harness,
        path,
        body: request
    });
    assert.equal(rejected.response.status, 409);
    assert.equal(rejected.body.type, 'api-mutation-failure');
    assert.equal(rejected.body.version, 'canonical.v2');
    assert.deepEqual(await mutationCounts(harness.sql, harness.documentKey), before);
    assert.deepEqual(await readStrictAppInboxPersistence(harness.sql, 'quota-rejected-route'), {
        inboxCount: 1,
        inboxStatus: 'FAILED',
        resultCount: 1,
        resultStatus: 'FAILED'
    });

    const beforeReplay = await mutationCounts(harness.sql, harness.documentKey);
    const replay = await postJson(harness.app, path, request);
    assert.equal(replay.response.status, 409);
    assert.deepEqual(replay.body, rejected.body);
    assert.deepEqual(await mutationCounts(harness.sql, harness.documentKey), beforeReplay);
    assert.deepEqual(await readStrictAppInboxPersistence(harness.sql, 'quota-rejected-route'), {
        inboxCount: 1,
        inboxStatus: 'FAILED',
        resultCount: 1,
        resultStatus: 'FAILED'
    });

    const conflict = await postJson(harness.app, path, {
        document: DOCUMENT_WIRE,
        reason: 'quota-rejected-changed-intent'
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.code, 'app-inbox-idempotency-conflict');
    assert.deepEqual(await mutationCounts(harness.sql, harness.documentKey), beforeReplay);
    await harness.sql`
    update crdt_documents
    set quota_policy = ${JSON.stringify({ maxDocumentBytes: 100000 })}
    where document_key = ${harness.documentKey}
  `;
}

async function verifyStrictCrdtHttpIdempotency(
    harness: CrdtAdminRouteHarness
): Promise<void> {
    await verifyEqualStrictCrdtHttpContenders(harness);

    const requestId = 'strict-crdt-request-0001';
    const compactPath = `/api/crdt/admin/documents/compact/requests/${requestId}`;
    const first = await postAndProcess({
        ...harness,
        path: compactPath,
        body: { document: DOCUMENT_WIRE, reason: 'strict-replay' }
    });
    const afterFirst = await mutationCounts(harness.sql, harness.documentKey);
    const replay = await postJson(harness.app, compactPath, {
        reason: 'strict-replay',
        document: {
            documentId: 'document-1',
            documentType: 'checklist',
            scope: 'room',
            workspaceId: 'workspace-1',
            applicationId: 'app-1',
            roomRef: { groupId: 'group-1', workspaceId: 'workspace-1', applicationId: 'app-1' }
        }
    });
    assert.equal(replay.response.status, 200);
    assert.deepEqual(replay.body, first);
    assert.deepEqual(await mutationCounts(harness.sql, harness.documentKey), afterFirst);

    const conflict = await postJson(harness.app, compactPath, {
        document: DOCUMENT_WIRE,
        reason: 'changed-intent'
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.type, 'api-mutation-failure');
    assert.equal(conflict.body.code, 'app-inbox-idempotency-conflict');
    assert.deepEqual(await mutationCounts(harness.sql, harness.documentKey), afterFirst);

    const operation = await postAndProcess({
        ...harness,
        path: `/api/crdt/admin/documents/rebuild-projection/requests/${requestId}`,
        body: { document: DOCUMENT_WIRE, projectionId: 'strict-projection' }
    });
    assert.equal(operation.ok, true);

    const otherAdmin = harness.appForSession({
        clientId: 'other-admin',
        username: 'other-admin',
        sessionId: 'other-admin-session',
        accessToken: 'other-token',
        issuedAtEpochMs: Date.now(),
        expiresAtEpochMs: Date.now() + 60_000
    });
    const actor = await postAndProcess({
        ...harness,
        app: otherAdmin,
        path: compactPath,
        body: { document: DOCUMENT_WIRE, reason: 'strict-replay' }
    });
    assert.equal(actor.ok, true);

    const missingRequestId = 'strict-missing-document-0001';
    for (const documentId of ['missing-a', 'missing-b']) {
        const missing = await postAndProcessRaw({
            ...harness,
            path: `/api/crdt/admin/documents/compact/requests/${missingRequestId}`,
            body: { document: { ...DOCUMENT_WIRE, documentId }, reason: 'document-isolation' }
        });
        assert.equal(missing.response.status, 404);
    }

    const scoped = await harness.sql<Readonly<{
        ri_topic_id: string;
        ri_resource_id: string;
        context_id: string;
    }>[]>`
    select ri_topic_id, ri_resource_id, fk_ext_bank_id as context_id
    from resource_inbox
    where ri_type_id = 'APP_INBOX' and ri_resource_id = ${requestId}
    order by ri_topic_id, context_id
  `;
    assert.equal(scoped.length, 3);
    assert.ok(scoped.every((row) => row.ri_resource_id === requestId));
    assert.deepEqual(scoped.map((row) => row.ri_topic_id), [
        'CRDT_PROJECTION_REBUILD',
        'CRDT_SNAPSHOT_COMPACT',
        'CRDT_SNAPSHOT_COMPACT'
    ]);
    assert.equal(new Set(scoped.map((row) => row.context_id)).size, 2);

    const documents = await harness.sql<Readonly<{ context_id: string; }>[]>`
    select fk_ext_bank_id as context_id from resource_inbox
    where ri_type_id = 'APP_INBOX' and ri_resource_id = ${missingRequestId}
  `;
    assert.equal(documents.length, 2);
    assert.equal(new Set(documents.map((row) => row.context_id)).size, 2);

    await verifyMalformedStrictCrdtDurableResult(harness);
}

async function verifyEqualStrictCrdtHttpContenders(
    harness: CrdtAdminRouteHarness
): Promise<void> {
    const requestId = 'strict-crdt-concurrent-request';
    const path = `/api/crdt/admin/documents/rebuild-projection/requests/${requestId}`;
    const request = { document: DOCUMENT_WIRE, projectionId: 'equal-concurrent' };
    const beforeEffects = await mutationCounts(harness.sql, harness.documentKey);
    const beforeFacts = harness.readMaterializationCounts();
    const firstPending = postJson(harness.app, path, request);
    const contenderPending = postJson(harness.app, path, request);

    await waitForPGliteQueueRow(harness.sql, 'APP_INBOX', 'NEW');
    assert.deepEqual(harness.readMaterializationCounts(), {
        clocks: beforeFacts.clocks + 1,
        ids: beforeFacts.ids + 1
    });
    await harness.inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, toResilienceDto());
    const [first, contender] = await Promise.all([firstPending, contenderPending]);

    assert.equal(first.response.status, 200);
    assert.equal(contender.response.status, 200);
    assert.deepEqual(contender.body, first.body);
    assert.deepEqual(harness.readMaterializationCounts(), {
        clocks: beforeFacts.clocks + 1,
        ids: beforeFacts.ids + 1
    });
    const afterEffects = await mutationCounts(harness.sql, harness.documentKey);
    assert.deepEqual(afterEffects, {
        revision: beforeEffects.revision + 1,
        snapshots: beforeEffects.snapshots,
        updates: beforeEffects.updates,
        outbox: beforeEffects.outbox
    });
    assert.deepEqual(await readStrictAppInboxPersistence(harness.sql, requestId), {
        inboxCount: 1,
        inboxStatus: 'COMPLETED',
        resultCount: 1,
        resultStatus: 'COMPLETED'
    });
}

async function verifyMalformedStrictCrdtDurableResult(
    harness: CrdtAdminRouteHarness
): Promise<void> {
    const requestId = 'strict-crdt-malformed-result';
    const path = `/api/crdt/admin/documents/compact/requests/${requestId}`;
    const request = { document: DOCUMENT_WIRE, reason: 'malformed-result' };
    await postAndProcess({ ...harness, path, body: request });
    const beforeReplay = await mutationCounts(harness.sql, harness.documentKey);
    const corrupted = await harness.sql<Readonly<{ ris_resource_id: string; }>[]>`
    update resource_inbox_results
    set ris_resource = ${JSON.stringify({ version: 1, operation: 'compact' })}
    where ris_resource_id = ${requestId} and ris_topic_id = 'CRDT_SNAPSHOT_COMPACT'
    returning ris_resource_id
  `;
    assert.equal(corrupted.length, 1);

    const replay = await postJson(harness.app, path, request);
    assert.equal(replay.response.status, 400);
    assert.equal(replay.body.type, 'api-mutation-failure');
    assert.equal(replay.body.version, 'canonical.v2');
    assert.deepEqual(await mutationCounts(harness.sql, harness.documentKey), beforeReplay);
    assert.deepEqual(await readStrictAppInboxPersistence(harness.sql, requestId), {
        inboxCount: 1,
        inboxStatus: 'COMPLETED',
        resultCount: 1,
        resultStatus: 'COMPLETED'
    });
}

async function verifyCompactResponse(harness: CrdtAdminRouteHarness): Promise<void> {
    const compact = await postAndProcess({
        ...harness,
        path: '/api/crdt/admin/documents/compact/requests/compact-route-request',
        body: {
            document: DOCUMENT_WIRE,
            reason: 'compact-route'
        }
    });
    assert.equal(compact.ok, true);
    const result = requireJsonWireObject(compact.result, 'compact result');
    const snapshot = requireJsonWireObject(result.snapshot, 'compact snapshot');
    const document = requireJsonWireObject(snapshot.document, 'compact snapshot document');
    assert.equal(result.appendSequence, 1);
    assert.equal(document.documentId, DOCUMENT.documentId);
}

async function verifyLifecycleResponse(harness: CrdtAdminRouteHarness): Promise<void> {
    const lifecycle = await postAndProcess({
        ...harness,
        path: '/api/crdt/admin/documents/lifecycle/requests/lifecycle-route-request',
        body: {
            document: DOCUMENT_WIRE,
            lifecycle: 'archived'
        }
    });
    const result = requireJsonWireObject(lifecycle.result, 'lifecycle result');
    assert.equal(result.lifecycle, 'archived');
    assert.equal(result.documentKey, harness.documentKey);
    assert.deepEqual(result.retention, { mode: 'retain', reason: 'existing' });
    assert.deepEqual(result.quota, { maxDocumentBytes: 100000 });
    assert.deepEqual(result.projectionIds, [
        'existing-projection',
        'equal-concurrent',
        'strict-projection'
    ]);
}

async function verifyEraseResponseAndAuditDelivery(
    harness: CrdtAdminRouteHarness
): Promise<void> {
    const erase = await postAndProcess({
        ...harness,
        path: '/api/crdt/admin/documents/erase/requests/erase-route-request-id',
        body: {
            document: DOCUMENT_WIRE,
            mode: 'destroy-document',
            reason: 'privacy'
        }
    });
    const result = requireJsonWireObject(erase.result, 'erase result');
    assert.equal(
        requireJsonWireObject(result.request, 'erase request').mode,
        'destroy-document'
    );
    assert.equal(requireJsonWireObject(result.auditEvent, 'erase audit event').kind, 'erase');
    assert.equal(requireJsonWireObject(result.metadata, 'erase metadata').lifecycle, 'destroyed');
    assert.equal(harness.audit.length, 0);
    assert.equal(await readAuditCount(harness.sql, 'ri_status = \'NEW\''), 1);
    await waitForPGliteQueueRow(harness.sql, 'APP_OUTBOX', 'NEW');
    await harness.outbox.dequeueOutbox(
        OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
        toResilienceDto()
    );
    assert.equal(harness.readAuditAttempts(), 2);
    assert.equal(harness.audit.length, 1);
    assert.equal(await readAuditCount(harness.sql, 'ri_status = \'COMPLETED\''), 1);
}

async function readAuditCount(
    sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0],
    statusPredicate: 'ri_status = \'NEW\'' | 'ri_status = \'COMPLETED\''
): Promise<number> {
    const rows = statusPredicate === 'ri_status = \'NEW\''
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
            }
        },
        requireAuth: false,
        requireApiAdminSession: () => {
            throw Object.assign(new Error('Unauthorized: expired session'), { status: 401 });
        },
        requireApiUserSession: () => Promise.reject(new Error('unused'))
    });
    const unauthorizedResponse = await unauthorized.request(
        '/api/crdt/admin/documents/compact/requests/unauthorized-request',
        {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ document: DOCUMENT_WIRE })
        }
    );
    assert.equal(unauthorizedResponse.status, 401);
    assert.equal(
        (await readJsonRecord(unauthorizedResponse)).type,
        'api-mutation-failure'
    );

    const forbidden = new Hono();
    routes.registerCrdtAdminRoutes(forbidden, {
        repository: createUnusedCrdtReadRepository(),
        crdtAdminMutations: {
            writeCrdtAdminMutation: () => {
                throw new Error('mutation must not run');
            }
        },
        requireAuth: false,
        requireApiAdminSession: () =>
            Promise.resolve({
                clientId: 'non-admin',
                username: 'non-admin',
                sessionId: 'session-1',
                accessToken: 'token',
                issuedAtEpochMs: Date.now(),
                expiresAtEpochMs: Date.now() + 60_000
            }),
        requireApiUserSession: () => Promise.reject(new Error('unused')),
        authorizeAdmin: () => false
    });
    const forbiddenResponse = await forbidden.request(
        '/api/crdt/admin/documents/compact/requests/forbidden-request-id',
        {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ document: DOCUMENT_WIRE })
        }
    );
    assert.equal(forbiddenResponse.status, 403);
    assert.equal(
        (await readJsonRecord(forbiddenResponse)).type,
        'api-mutation-failure'
    );
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
        verifyIntegrity: unused
    };
}

async function mutationCounts(
    sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0],
    documentKey: string
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
        outbox: Number(counts.outbox)
    };
}

async function readStrictAppInboxPersistence(
    sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0],
    requestId: string
): Promise<
    Readonly<{
        inboxCount: number;
        inboxStatus: string | null;
        resultCount: number;
        resultStatus: string | null;
    }>
> {
    const [persistence] = await sql<AppInboxPersistenceRow[]>`
    select
      (select count(*) from resource_inbox where ri_resource_id = ${requestId})
        as inbox_count,
      (select ri_status from resource_inbox where ri_resource_id = ${requestId} limit 1)
        as inbox_status,
      (select count(*) from resource_inbox_results where ris_resource_id = ${requestId})
        as result_count,
      (select ris_status from resource_inbox_results where ris_resource_id = ${requestId} limit 1)
        as result_status
  `;
    if (!persistence) {
        throw new Error('CRDT AppInbox persistence counts are missing');
    }
    return {
        inboxCount: Number(persistence.inbox_count),
        inboxStatus: persistence.inbox_status,
        resultCount: Number(persistence.result_count),
        resultStatus: persistence.result_status
    };
}

interface PostAndProcessInput {
    readonly app: Hono;
    readonly inbox: InboxQueueReader;
    readonly sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0];
    readonly path: string;
    readonly body: JsonWireValue;
}

async function postAndProcess(
    input: PostAndProcessInput
): Promise<JsonWireObject> {
    const { app, inbox, sql, path, body } = input;
    const responsePending = app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
    await inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, toResilienceDto());
    return await readJsonRecord(await responsePending);
}

async function postAndProcessRaw(
    input: PostAndProcessInput
): Promise<PostAndProcessRawResult> {
    const { app, inbox, sql, path, body } = input;
    const responsePending = app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
    await inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, toResilienceDto());
    const response = await responsePending;
    return { response, body: await readJsonRecord(response) };
}

async function postJson(
    app: Hono,
    path: string,
    body: JsonWireValue
): Promise<PostAndProcessRawResult> {
    const response = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    return { response, body: await readJsonRecord(response) };
}

async function readJsonRecord(response: Response): Promise<JsonWireObject> {
    const value: unknown = await response.json();
    return requireJsonWireObject(value, 'CRDT admin response');
}

function requireJsonWireObject(value: unknown, label: string): JsonWireObject {
    if (!isJsonWireObject(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}

function isJsonWireObject(value: unknown): value is JsonWireObject {
    return value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.values(value).every(isJsonWireValue);
}

function isJsonWireValue(value: unknown): value is JsonWireValue {
    if (
        value === null ||
        typeof value === 'boolean' ||
        typeof value === 'string'
    ) {
        return true;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value);
    }
    if (Array.isArray(value)) {
        return value.every(isJsonWireValue);
    }
    return isJsonWireObject(value);
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
            operations: [{ kind: 'register.set', path: ['title'], policy: 'lww', value: 'initial' }]
        }
    };
}
