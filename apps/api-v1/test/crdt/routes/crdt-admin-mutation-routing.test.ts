import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';

import type {
  IssuedAuthSession,
} from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import {
  InMemoryRallarCrdtLogRepository,
} from '@shared-server/rallar-system/crdt/persistence/in-memory-crdt-log-repository.ts';
import type { RallarCrdtAdminReadRepository, RallarCrdtDocumentRef } from '@shared/crdt/mod.ts';

import type {
  CrdtAdminMutationInput,
  CrdtAdminPublicResult,
} from '../../../src/crdt/create-crdt-admin-mutations.ts';
import * as crdtAdminRoutes from '../../../src/crdt/register-crdt-admin-routes.ts';

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

interface CrdtAdminMutationCall {
  readonly operation: string;
  readonly input: CrdtAdminMutationInput;
}

interface CrdtAdminRoutingFixture {
  readonly app: Hono;
  readonly directCalls: readonly string[];
  readonly mutationCalls: readonly CrdtAdminMutationCall[];
}

Deno.test('CRDT admin mutating routes use AppCrdt while read operations stay direct', async () => {
  const fixture = createCrdtAdminRoutingFixture();
  await exerciseCrdtAdminReadRoutes(fixture.app);
  await exerciseCrdtAdminMutationRoutes(fixture.app);

  assert.deepEqual(fixture.directCalls, [
    'list',
    'integrity',
    'debug',
    'backup',
    'catch-up-log',
    'catch-up-snapshot',
  ]);
  assert.deepEqual(fixture.mutationCalls.map((call) => call.operation), [
    'rebuild-projection',
    'compact',
    'lifecycle',
    'erase',
  ]);
  assert.ok(fixture.mutationCalls.every((call) => call.input.adminSession === SESSION));
});

function createCrdtAdminRoutingFixture(): CrdtAdminRoutingFixture {
  const directCalls: string[] = [];
  const mutationCalls: CrdtAdminMutationCall[] = [];
  const directRepository = new InMemoryRallarCrdtLogRepository({ now: () => NOW });
  const app = new Hono();
  crdtAdminRoutes.registerCrdtAdminRoutes(app, {
    repository: createRecordingCrdtReadRepository(directCalls, directRepository),
    crdtAdminMutations: {
      writeCrdtAdminMutation: (input) => {
        mutationCalls.push({ operation: input.operation, input });
        return Promise.resolve(toCrdtAdminRoutingResult(input));
      },
    },
    requireApiAdminSession: () => Promise.resolve(SESSION),
    requireApiUserSession: () => Promise.resolve(SESSION),
    adminClientIds: ['platform-admin'],
    now: () => NOW,
  });
  return { app, directCalls, mutationCalls };
}

async function exerciseCrdtAdminReadRoutes(app: Hono): Promise<void> {
  const list = await post(app, '/api/crdt/admin/documents/list', {});
  const integrity = await post(app, '/api/crdt/admin/documents/integrity', {
    document: DOCUMENT,
  });
  const debug = await post(app, '/api/crdt/admin/documents/debug-export', {
    document: DOCUMENT,
  });
  const backup = await post(app, '/api/crdt/admin/documents/backup-export', {
    document: DOCUMENT,
  });
  const catchUp = await post(app, '/api/crdt/catch-up', { document: DOCUMENT });
  for (const response of [list, integrity, debug, backup, catchUp]) {
    assert.equal(response.status, 200);
  }
}

async function exerciseCrdtAdminMutationRoutes(app: Hono): Promise<void> {
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
    const response = await post(app, `${path}/requests/crdt-routing-request-001`, body);
    assert.equal(response.status, 200);
    const responseBody = await readJsonObject(response);
    assert.equal(responseBody.ok, true, operation);
  }
}

function createRecordingCrdtReadRepository(
  calls: string[],
  repository: InMemoryRallarCrdtLogRepository,
): RallarCrdtAdminReadRepository {
  return createCrdtReadRepository({
    listDocuments: () => {
      calls.push('list');
      return Promise.resolve({ documents: [], nextCursor: undefined, hasMore: false });
    },
    verifyIntegrity: () => {
      calls.push('integrity');
      return Promise.resolve({
        documentKey: 'app-1:workspace-1:room:checklist:doc-1',
        valid: true,
        checkedUpdateCount: 0,
        sequenceGaps: [],
        issues: [],
      });
    },
    exportDebugBundle: (document, options) => {
      calls.push('debug');
      return repository.exportDebugBundle(document, options);
    },
    exportBackupBundle: (document, options) => {
      calls.push('backup');
      return repository.exportBackupBundle(document, options);
    },
    listAfter: () => {
      calls.push('catch-up-log');
      return Promise.resolve({
        document: DOCUMENT,
        records: [],
        firstSequence: 0,
        lastSequence: 0,
        hasMore: false,
      });
    },
    readSnapshot: () => {
      calls.push('catch-up-snapshot');
      return Promise.resolve(undefined);
    },
  });
}

Deno.test('CRDT admin routes never fall back to direct mutation methods', async () => {
  let directMutationCalls = 0;
  const app = new Hono();
  crdtAdminRoutes.registerCrdtAdminRoutes(app, {
    repository: Object.assign(createCrdtReadRepository(), {
      writeSnapshot: () => {
        directMutationCalls += 1;
        return Promise.resolve();
      },
      updateDocumentLifecycle: () => {
        directMutationCalls += 1;
        return Promise.reject(new Error('direct lifecycle mutation must not run'));
      },
      rebuildProjection: () => {
        directMutationCalls += 1;
        return Promise.reject(new Error('direct projection mutation must not run'));
      },
    }),
    crdtAdminMutations: {
      writeCrdtAdminMutation: (input) => Promise.resolve(toCrdtAdminRoutingResult(input)),
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
      (await post(app, `${path}/requests/crdt-routing-request-001`, {
        document: DOCUMENT,
        lifecycle: 'archived',
        mode: 'destroy-document',
      })).status,
      200,
    );
  }
  assert.equal(directMutationCalls, 0);
});

Deno.test('CRDT admin routes preserve retryable mutation failure status', async () => {
  for (const status of [429, 503] as const) {
    const app = new Hono();
    crdtAdminRoutes.registerCrdtAdminRoutes(app, {
      repository: createCrdtReadRepository(),
      crdtAdminMutations: {
        writeCrdtAdminMutation: () => {
          throw Object.assign(new Error(`mutation unavailable ${status}`), { status });
        },
      },
      requireApiAdminSession: () => Promise.resolve(SESSION),
      requireApiUserSession: () => Promise.resolve(SESSION),
      adminClientIds: ['platform-admin'],
    });

    const response = await post(
      app,
      '/api/crdt/admin/documents/compact/requests/crdt-routing-request-001',
      {
        document: DOCUMENT,
      },
    );
    assert.equal(response.status, status);
    assert.deepEqual(await readJsonObject(response), {
      type: 'api-mutation-failure',
      version: 'canonical.v1',
      code: status === 503 ? 'api-mutation-unavailable' : 'api-mutation-429',
      status,
      message: `mutation unavailable ${status}`,
      issues: null,
      denial: null,
      retry: status === 503
        ? {
          kind: 'unavailable',
          attempts: null,
          lane: null,
          queueAgeMs: null,
          dueAgeMs: null,
          retryAfterMs: null,
        }
        : null,
    });
  }
});

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

function toCrdtAdminRoutingResult(input: CrdtAdminMutationInput): CrdtAdminPublicResult {
  const metadata = {
    document: DOCUMENT,
    documentKey: 'app-1/workspace-1/room/checklist/doc-1',
    documentRevision: 1,
    lifecycle: 'active' as const,
    createdAtEpochMs: NOW,
    updatedAtEpochMs: NOW,
    archivedAtEpochMs: null,
    destroyedAtEpochMs: null,
    lastAppendSequence: 0,
    updateCount: 0,
    snapshotCount: 0,
    storedUpdateBytes: 0,
    retention: null,
    quota: null,
    projectionIds: [],
  };
  switch (input.operation) {
    case 'rebuild-projection':
      return {
        documentKey: metadata.documentKey,
        valid: true,
        checkedUpdateCount: 0,
        sequenceGaps: [],
        issues: [],
      };
    case 'compact':
      return {
        document: DOCUMENT,
        documentKey: metadata.documentKey,
        appendSequence: 0,
        snapshot: {
          protocolVersion: 1,
          document: DOCUMENT,
          snapshotId: 'snapshot-1',
          schemaVersion: 1,
          createdAtEpochMs: NOW,
          maxLamport: 0,
          includedUpdateIds: [],
          value: null,
          metadata: { updateCount: 0, reason: 'routing-test' },
        },
      };
    case 'lifecycle':
      return metadata;
    case 'erase':
      return {
        request: {
          document: DOCUMENT,
          requestedAtEpochMs: NOW,
          requestedBy: SESSION.clientId,
          reason: 'routing-test',
          mode: 'destroy-document',
        },
        auditEvent: { kind: 'erase', atEpochMs: NOW },
        metadata,
      };
  }
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  return requireRecord(value, 'CRDT admin route response');
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

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
