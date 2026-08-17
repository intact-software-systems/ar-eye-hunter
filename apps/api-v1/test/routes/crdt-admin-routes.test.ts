import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import type { AuthSession } from '@shared/api/api-config.ts';
import type {
  IssuedAuthSession,
} from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { RallarCrdtDocumentRef } from '@shared/crdt/mod.ts';
import * as crdtAdminRoutes from '../../src/routes/crdt-admin-routes.ts';

const NOW = 1_700_000_000_000;
const SESSION: IssuedAuthSession = {
  clientId: 'platform-admin',
  username: 'admin',
  accessToken: 'token',
  sessionId: 'admin-session',
  issuedAtEpochMs: NOW,
  expiresAtEpochMs: NOW + 60_000,
};
const DOCUMENT: RallarCrdtDocumentRef = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
  scope: 'room',
  documentType: 'checklist',
  documentId: 'doc-1',
  roomRef: {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'group-1',
  },
};

Deno.test('CRDT admin mutating routes use AppCrdt while read operations stay direct', async () => {
  const directCalls: string[] = [];
  const mutationCalls: Array<{ operation: string; input: unknown }> = [];
  const app = new Hono();
  crdtAdminRoutes.registerCrdtAdminRoutes(app, {
    repository: {
      listDocuments: () => {
        directCalls.push('list');
        return Promise.resolve({ documents: [], nextCursor: undefined, hasMore: false });
      },
      verifyIntegrity: () => {
        directCalls.push('integrity');
        return Promise.resolve({ valid: true });
      },
      exportDebugBundle: () => Promise.reject(new Error('unused')),
      exportBackupBundle: () => Promise.reject(new Error('unused')),
      listAfter: () => Promise.reject(new Error('unused')),
      readSnapshot: () => Promise.reject(new Error('unused')),
    } as never,
    mutations: {
      processAdminMutationUntilCompletion: (operation, input) => {
        mutationCalls.push({ operation, input });
        return Promise.resolve({ operation, status: 'completed' });
      },
    },
    requireApiAdminSession: () => Promise.resolve(SESSION),
    requireApiUserSession: () => Promise.resolve(SESSION),
    adminClientIds: ['platform-admin'],
    now: () => NOW,
  });

  const list = await post(app, '/api/crdt/admin/documents/list', {});
  const integrity = await post(app, '/api/crdt/admin/documents/integrity', {
    document: DOCUMENT,
  });
  for (
    const [path, operation, body] of [
      ['/api/crdt/admin/documents/rebuild-projection', 'rebuild-projection', {
        document: DOCUMENT,
        projectionId: 'summary',
      }],
      ['/api/crdt/admin/documents/compact', 'compact', {
        document: DOCUMENT,
        reason: 'operator',
      }],
      ['/api/crdt/admin/documents/lifecycle', 'lifecycle', {
        document: DOCUMENT,
        lifecycle: 'archived',
      }],
      ['/api/crdt/admin/documents/erase', 'erase', {
        document: DOCUMENT,
        mode: 'destroy-document',
      }],
    ] as const
  ) {
    const response = await post(app, path, body);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.operation, operation);
  }

  assert.equal(list.status, 200);
  assert.equal(integrity.status, 200);
  assert.deepEqual(directCalls, ['list', 'integrity']);
  assert.deepEqual(mutationCalls.map((call) => call.operation), [
    'rebuild-projection',
    'compact',
    'lifecycle',
    'erase',
  ]);
  assert.ok(
    mutationCalls.every((call) =>
      (call.input as { adminSession: AuthSession }).adminSession === SESSION
    ),
  );
});

Deno.test('CRDT admin routes never fall back to direct mutation methods', async () => {
  let directMutationCalls = 0;
  const app = new Hono();
  crdtAdminRoutes.registerCrdtAdminRoutes(app, {
    repository: {
      writeSnapshot: () => {
        directMutationCalls += 1;
        return Promise.resolve();
      },
      updateDocumentLifecycle: () => {
        directMutationCalls += 1;
        return Promise.resolve({} as never);
      },
      rebuildProjection: () => {
        directMutationCalls += 1;
        return Promise.resolve({} as never);
      },
    } as never,
    mutations: {
      processAdminMutationUntilCompletion: () => Promise.resolve({ status: 'queued' }),
    },
    requireApiAdminSession: () => Promise.resolve(SESSION),
    requireApiUserSession: () => Promise.resolve(SESSION),
    adminClientIds: ['platform-admin'],
  });

  for (
    const path of [
      '/api/crdt/admin/documents/rebuild-projection',
      '/api/crdt/admin/documents/compact',
      '/api/crdt/admin/documents/lifecycle',
      '/api/crdt/admin/documents/erase',
    ]
  ) {
    assert.equal(
      (await post(app, path, {
        document: DOCUMENT,
        lifecycle: 'archived',
        mode: 'destroy-document',
      })).status,
      200,
    );
  }
  assert.equal(directMutationCalls, 0);
});

async function post(app: Hono, path: string, body: unknown): Promise<Response> {
  return await app.request(path, {
    method: 'POST',
    headers: {
      authorization: 'Bearer token',
      'x-client-id': SESSION.clientId,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}
