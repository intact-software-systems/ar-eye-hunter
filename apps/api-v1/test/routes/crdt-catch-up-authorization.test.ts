import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';

import type { AuthSession } from '@shared/api/api-config.ts';
import type {
  IssuedAuthSession,
} from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import {
  RALLAR_CRDT_OPERATION_VERSION,
  RALLAR_CRDT_PROTOCOL_VERSION,
  type RallarCrdtAdminReadRepository,
  type RallarCrdtDocumentRef,
  type RallarCrdtSnapshotEnvelope,
  type RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';

import * as crdtAdminRoutes from '../../src/routes/crdt-admin-routes.ts';

const NOW = 1_700_000_000_000;
const USER: IssuedAuthSession = {
  clientId: 'alice',
  username: 'alice',
  accessToken: 'token',
  sessionId: 'alice-session',
  issuedAtEpochMs: NOW,
  expiresAtEpochMs: NOW + 60_000,
};
const DOCUMENT: RallarCrdtDocumentRef = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
  scope: 'room',
  documentType: 'checklist',
  documentId: 'doc-1',
  roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' },
};

interface CatchUpAuthorizationInput {
  readonly document: RallarCrdtDocumentRef;
  readonly session: AuthSession;
}

Deno.test(
  'durable CRDT catch-up denies an authenticated non-member without reading the log',
  async () => {
    let logReads = 0;
    const app = new Hono();
    crdtAdminRoutes.registerCrdtAdminRoutes(app, {
      repository: createCrdtReadRepository({
        listAfter: () => {
          logReads += 1;
          return Promise.reject(new Error('log must not be read on denial'));
        },
        readSnapshot: () => {
          logReads += 1;
          return Promise.reject(new Error('snapshot must not be read on denial'));
        },
      }),
      requireApiUserSession: () => Promise.resolve(USER),
      requireApiAdminSession: () => Promise.resolve(USER),
      authorizeCatchUp: () => Promise.resolve({ allowed: false }),
    });

    const response = await postCatchUp(app, { document: DOCUMENT });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'Forbidden: CRDT catch-up authorization required.');
    assert.equal(logReads, 0);
  },
);

Deno.test('durable CRDT catch-up serves the log for an authorized caller', async () => {
  const app = new Hono();
  const authorizeInputs: CatchUpAuthorizationInput[] = [];
  const update = createCatchUpUpdate();
  crdtAdminRoutes.registerCrdtAdminRoutes(app, {
    repository: createCrdtReadRepository({
      listAfter: () =>
        Promise.resolve({
          document: DOCUMENT,
          records: [{
            document: DOCUMENT,
            documentKey: 'app-1:workspace-1:room:checklist:doc-1',
            update,
            append: {
              appendSequence: 1,
              acceptedAtEpochMs: NOW,
              actorId: 'alice',
              principalId: 'alice',
              sessionId: USER.sessionId,
              serverId: 'server-1',
              authorizationScope: 'room',
              acceptedUpdateHash: 'update-hash',
            },
          }],
          firstSequence: 1,
          lastSequence: 1,
          hasMore: false,
        }),
      readSnapshot: () => Promise.resolve(createCatchUpSnapshot()),
    }),
    now: () => NOW,
    requireApiUserSession: () => Promise.resolve(USER),
    requireApiAdminSession: () => Promise.resolve(USER),
    authorizeCatchUp: (input) => {
      authorizeInputs.push(input);
      return Promise.resolve({ allowed: true });
    },
  });

  const response = await postCatchUp(app, { document: DOCUMENT });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.result.page.records[0].update.updateId, 'update-1');
  assert.equal(body.result.snapshot.snapshotId, 'snapshot-1');
  assert.equal(authorizeInputs.length, 1);
  assert.deepEqual(authorizeInputs[0].document, DOCUMENT);
  assert.equal(authorizeInputs[0].session.sessionId, 'alice-session');
});

Deno.test('durable CRDT catch-up rejects a missing bearer token with 401', async () => {
  const app = new Hono();
  crdtAdminRoutes.registerCrdtAdminRoutes(app, {
    repository: createCrdtReadRepository({
      listAfter: () => Promise.reject(new Error('unused')),
      readSnapshot: () => Promise.reject(new Error('unused')),
    }),
    requireApiUserSession: () => {
      throw new Error('Unauthorized: Missing bearer token');
    },
    requireApiAdminSession: () => Promise.resolve(USER),
    authorizeCatchUp: () => Promise.resolve({ allowed: true }),
  });

  const response = await postCatchUp(app, { document: DOCUMENT });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'Unauthorized: Missing bearer token');
});

Deno.test(
  'CRDT admin middleware denies a non-admin with 403 on the authenticated route',
  async () => {
    const app = new Hono();
    crdtAdminRoutes.registerCrdtAdminRoutes(app, {
      repository: createCrdtReadRepository(),
      mutations: {
        writeCrdtAdminMutation: () => {
          throw new Error('mutation must not run');
        },
      },
      requireApiAdminSession: () =>
        Promise.resolve({
          clientId: 'non-admin',
          username: 'non-admin',
          sessionId: 'session-1',
          accessToken: 'token',
          issuedAtEpochMs: NOW,
          expiresAtEpochMs: NOW + 60_000,
        }),
      requireApiUserSession: () => Promise.resolve(USER),
      authorizeAdmin: () => false,
    });

    const response = await app.request('/api/crdt/admin/documents/compact', {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'x-client-id': 'non-admin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ document: DOCUMENT }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'Forbidden: CRDT admin authorization required.');
  },
);

function createCrdtReadRepository(
  overrides: Partial<RallarCrdtAdminReadRepository> = {},
): RallarCrdtAdminReadRepository {
  const unused = () => Promise.reject(new Error('CRDT read operation is unused'));
  return {
    listAfter: unused,
    readSnapshot: unused,
    readDocumentMetadata: unused,
    listDocuments: unused,
    exportDebugBundle: unused,
    exportBackupBundle: unused,
    verifyIntegrity: unused,
    ...overrides,
  };
}

function createCatchUpUpdate(): RallarCrdtUpdateEnvelope {
  return {
    protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
    document: DOCUMENT,
    updateId: 'update-1',
    replicaId: 'replica-1',
    lamport: 1,
    parents: [],
    schemaVersion: 1,
    operationVersion: RALLAR_CRDT_OPERATION_VERSION,
    createdAtEpochMs: NOW,
    payload: { kind: 'batch', operations: [] },
  };
}

function createCatchUpSnapshot(): RallarCrdtSnapshotEnvelope {
  return {
    protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
    document: DOCUMENT,
    snapshotId: 'snapshot-1',
    schemaVersion: 1,
    createdAtEpochMs: NOW,
    maxLamport: 1,
    includedUpdateIds: ['update-1'],
    value: {},
    metadata: { updateCount: 1 },
  };
}

async function postCatchUp(app: Hono, body: unknown): Promise<Response> {
  return await app.request('/api/crdt/catch-up', {
    method: 'POST',
    headers: {
      authorization: 'Bearer token',
      'x-client-id': USER.clientId,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}
