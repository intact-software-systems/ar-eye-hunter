import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';

import {
  hashRallarCrdtUpdateEnvelope,
  InMemoryRallarCrdtAuditSink,
  RALLAR_CRDT_OPERATION_VERSION,
  RALLAR_CRDT_PROTOCOL_VERSION,
  rallarCrdtBatch,
  type RallarCrdtDocumentRef,
  type RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';
import { InMemoryRallarCrdtLogRepository } from '@shared-server/rallar-system/crdt/persistence/in-memory-crdt-log-repository.ts';

import { registerCrdtAdminRoutes } from '../../src/routes/crdt-admin-routes.ts';

Deno.test('CRDT admin routes expose read-only repository health operations', async () => {
  const audit = new InMemoryRallarCrdtAuditSink();
  const repository = new InMemoryRallarCrdtLogRepository({
    now: () => 10_000,
    audit,
  });
  const update = createCrdtUpdate('update-1');
  await repository.append({
    update,
    trusted: {
      authorizationScope: 'room',
      actorId: 'actor-a',
      principalId: 'principal-a',
      sessionId: 'session-a',
      serverId: 'server-a',
      acceptedAtEpochMs: 10_000,
    },
  });

  const app = new Hono();
  registerCrdtAdminRoutes(app, {
    repository,
    now: () => 12_000,
    requireAuth: false,
    requireApiAdminSession: () => Promise.reject(new Error('auth disabled')),
    requireApiUserSession: () => Promise.reject(new Error('auth disabled')),
  });

  const list = await postJson(app, '/api/crdt/admin/documents/list', {});
  assert.equal(list.ok, true);
  assert.equal(list.result.documents.length, 1);
  assert.equal(list.result.documents[0].updateCount, 1);

  const integrity = await postJson(app, '/api/crdt/admin/documents/integrity', {
    document: update.document,
  });
  assert.equal(integrity.ok, true);
  assert.equal(integrity.result.valid, true);
  assert.equal(integrity.result.checkedUpdateCount, 1);

  const debug = await postJson(app, '/api/crdt/admin/documents/debug-export', {
    document: update.document,
    reason: 'test-export',
  });
  assert.equal(debug.ok, true);
  assert.equal(debug.result.format, 'rallar.crdt.debug-bundle.v1');
  assert.equal(debug.result.redaction.payloadsRedacted, true);
  assert.deepEqual(debug.result.records[0].update.payload.operations, []);
});

const CRDT_ROOM_REF = {
  applicationId: 'rallar-test',
  workspaceId: 'main',
  groupId: 'room-1',
};

const CRDT_DOCUMENT_REF: RallarCrdtDocumentRef = {
  applicationId: 'rallar-test',
  workspaceId: 'main',
  scope: 'room',
  documentType: 'checklist',
  documentId: 'room-1',
  roomRef: CRDT_ROOM_REF,
};

function createCrdtUpdate(updateId: string): RallarCrdtUpdateEnvelope {
  const updateWithoutHash: RallarCrdtUpdateEnvelope = {
    protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
    document: CRDT_DOCUMENT_REF,
    updateId,
    replicaId: 'replica-a',
    actorId: 'actor-a',
    lamport: 1,
    parents: [],
    schemaVersion: 1,
    operationVersion: RALLAR_CRDT_OPERATION_VERSION,
    createdAtEpochMs: 9_000,
    payload: rallarCrdtBatch([
      {
        kind: 'map.set',
        path: [],
        key: 'title',
        value: 'Admin route test',
      },
    ]),
  };

  return {
    ...updateWithoutHash,
    hash: hashRallarCrdtUpdateEnvelope(updateWithoutHash),
  };
}

interface CrdtAdminDocumentJson {
  readonly updateCount: number;
}

interface CrdtAdminRedactionJson {
  readonly payloadsRedacted: boolean;
}

interface CrdtAdminUpdatePayloadJson {
  readonly operations: readonly unknown[];
}

interface CrdtAdminUpdateJson {
  readonly payload: CrdtAdminUpdatePayloadJson;
}

interface CrdtAdminRecordJson {
  readonly update: CrdtAdminUpdateJson;
}

interface CrdtAdminRouteResultJson {
  readonly documents: readonly CrdtAdminDocumentJson[];
  readonly valid: boolean;
  readonly checkedUpdateCount: number;
  readonly format: string;
  readonly redaction: CrdtAdminRedactionJson;
  readonly records: readonly CrdtAdminRecordJson[];
}

interface CrdtAdminRouteJson {
  readonly ok: boolean;
  readonly result: CrdtAdminRouteResultJson;
}

async function postJson(
  app: Hono,
  path: string,
  body: unknown,
): Promise<CrdtAdminRouteJson> {
  const response = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return await response.json() as CrdtAdminRouteJson;
}
