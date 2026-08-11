import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarCrdtDocumentRef } from '@shared/crdt/mod.ts';
import * as crdtAdminRoutes from '../../src/routes/crdt-admin-routes.ts';

const NOW = 1_700_000_000_000;
const USER: AuthSession = {
  clientId: 'alice',
  username: 'alice',
  accessToken: 'token',
  sessionId: 'alice-session',
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

Deno.test('durable CRDT catch-up denies an authenticated non-member without reading the log', async () => {
  let logReads = 0;
  const app = new Hono();
  crdtAdminRoutes.init(app, {
    repository: {
      listAfter: () => {
        logReads += 1;
        return Promise.reject(new Error('log must not be read on denial'));
      },
      readSnapshot: () => {
        logReads += 1;
        return Promise.reject(new Error('snapshot must not be read on denial'));
      },
    } as never,
    requireApiUserSession: () => Promise.resolve(USER),
    authorizeCatchUp: () => Promise.resolve({ allowed: false }),
  });

  const response = await postCatchUp(app, { document: DOCUMENT });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'Forbidden: CRDT catch-up authorization required.');
  assert.equal(logReads, 0);
});

Deno.test('durable CRDT catch-up serves the log for an authorized caller', async () => {
  const app = new Hono();
  const authorizeInputs: Array<{ document: RallarCrdtDocumentRef; session: AuthSession }> = [];
  crdtAdminRoutes.init(app, {
    repository: {
      listAfter: () =>
        Promise.resolve({ records: [{ update: { updateId: 'update-1' } }], hasMore: false }),
      readSnapshot: () => Promise.resolve({ snapshotId: 'snapshot-1' }),
    } as never,
    now: () => NOW,
    requireApiUserSession: () => Promise.resolve(USER),
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
  crdtAdminRoutes.init(app, {
    repository: {
      listAfter: () => Promise.reject(new Error('unused')),
      readSnapshot: () => Promise.reject(new Error('unused')),
    } as never,
    requireApiUserSession: () => {
      throw new Error('Unauthorized: Missing bearer token');
    },
    authorizeCatchUp: () => Promise.resolve({ allowed: true }),
  });

  const response = await postCatchUp(app, { document: DOCUMENT });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'Unauthorized: Missing bearer token');
});

Deno.test('CRDT admin middleware denies a non-admin with 403 on the authenticated route', async () => {
  const app = new Hono();
  crdtAdminRoutes.init(app, {
    repository: {} as never,
    mutations: {
      processAdminMutationUntilCompletion: () => {
        throw new Error('mutation must not run');
      },
    } as never,
    requireApiAdminSession: () =>
      Promise.resolve({
        clientId: 'non-admin',
        username: 'non-admin',
        sessionId: 'session-1',
        accessToken: 'token',
        expiresAtEpochMs: NOW + 60_000,
      }),
    authorizeAdmin: () => false,
  });

  const response = await app.request('/api/crdt/admin/documents/compact', {
    method: 'POST',
    headers: { authorization: 'Bearer token', 'x-client-id': 'non-admin', 'content-type': 'application/json' },
    body: JSON.stringify({ document: DOCUMENT }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'Forbidden: CRDT admin authorization required.');
});

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
