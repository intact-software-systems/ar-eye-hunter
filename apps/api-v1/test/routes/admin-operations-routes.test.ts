import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import type { AuthSession } from '@shared/api/api-config.ts';
import { Either } from '@shared/resilience/Either.ts';
import { toUnavailableAppInboxFailure } from '@shared-server/rallar-system/services/app-inbox-failure.ts';
import { createApiAdminMutationGateway } from '../../src/services/create-api-admin-mutation-gateway.ts';
import * as adminOperationsRoutes from '../../src/routes/admin-operations-routes.ts';

const NOW_EPOCH_MS = 1_700_000_000_000;
const ADMIN_SESSION: AuthSession = {
  clientId: 'platform-admin',
  username: 'admin',
  accessToken: 'access-token',
  sessionId: 'admin-session',
  expiresAtEpochMs: NOW_EPOCH_MS + 60_000,
};

Deno.test('admin operations routes reject unauthenticated requests with 401', async () => {
  const app = createApp({
    requireApiAuthSession: () => Promise.reject(new Error('Unauthorized: Missing bearer token')),
  });

  const response = await app.request('/api/admin/operations/overview');

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: 'Unauthorized: Missing bearer token',
  });
});

Deno.test('admin operations routes reject authenticated non-admin requests with 403', async () => {
  const app = createApp({
    requireApiAuthSession: () =>
      Promise.resolve({
        ...ADMIN_SESSION,
        clientId: 'regular-client',
      }),
  });

  const response = await app.request('/api/admin/operations/overview', {
    headers: {
      authorization: 'Bearer regular-token',
      'x-client-id': 'regular-client',
    },
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: 'Forbidden: platform admin authorization required',
  });
});

Deno.test('admin operations overview returns the service overview payload', async () => {
  const app = createApp();

  const response = await app.request('/api/admin/operations/overview', {
    headers: {
      authorization: 'Bearer admin-token',
      'x-client-id': 'platform-admin',
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    generatedAtEpochMs: NOW_EPOCH_MS,
    serverId: 'test-server',
    warnings: [],
    health: { status: 'ok' },
  });
});

Deno.test('admin operations scoped state route forwards application and workspace scope', async () => {
  const calls: unknown[] = [];
  const app = createApp({
    operations: {
      readState: (input: { scope?: unknown; adminSession?: unknown }) => {
        calls.push(input);
        return Promise.resolve({
          generatedAtEpochMs: NOW_EPOCH_MS,
          serverId: 'test-server',
          scope: input.scope,
          warnings: [],
          clients: { totalPrincipals: 0, onlinePrincipals: 0, activeSessions: 0 },
          groups: { activeGroups: 0, totalActiveMembers: 0, onlineMembers: 0 },
          events: { recentClientEvents: 0, recentGroupEvents: 0 },
        });
      },
    },
  });

  const response = await app.request(
    '/api/admin/operations/state/apps/app-1/workspaces/workspace-1',
    {
      headers: {
        authorization: 'Bearer admin-token',
        'x-client-id': 'platform-admin',
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).scope, {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
  });
  assert.deepEqual(calls, [
    {
      scope: {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
      },
      adminSession: ADMIN_SESSION,
    },
  ]);
});

Deno.test('admin operations metrics reset forwards request body and admin session', async () => {
  const calls: unknown[] = [];
  const app = createApp({
    operations: {
      resetMetrics: (input: { request?: unknown; adminSession?: unknown }) => {
        calls.push(input);
        return Promise.resolve({
          generatedAtEpochMs: NOW_EPOCH_MS,
          serverId: 'test-server',
          warnings: [],
          operation: 'metrics.reset',
          status: 'completed',
          changed: true,
          before: { rtcTopology: { recomputeCount: 2 } },
          after: { rtcTopology: { recomputeCount: 0 } },
        });
      },
    },
  });

  const response = await app.request('/api/admin/operations/metrics/reset', {
    method: 'POST',
    headers: {
      authorization: 'Bearer admin-token',
      'x-client-id': 'platform-admin',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requestId: 'reset-1',
      categories: ['rtc-topology'],
      reason: 'operator-test',
    }),
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).changed, true);
  assert.deepEqual(calls, [
    {
      request: {
        requestId: 'reset-1',
        categories: ['rtc-topology'],
        reason: 'operator-test',
      },
      adminSession: ADMIN_SESSION,
    },
  ]);
});

Deno.test('admin prune pending completion preserves its typed 503 response', async () => {
  const gateway = createApiAdminMutationGateway({
    appAdmin: {
      pruneExpired: () => Promise.resolve(Either.ofLeft(toUnavailableAppInboxFailure())),
    } as never,
    appCrdt: {} as never,
    appGroup: {} as never,
    now: () => NOW_EPOCH_MS,
  });
  const app = createApp({ operations: { pruneExpired: gateway.pruneExpired } });

  const response = await app.request('/api/admin/operations/maintenance/prune-expired', {
    method: 'POST',
    headers: {
      authorization: 'Bearer admin-token',
      'x-client-id': 'platform-admin',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ requestId: 'pending-prune', dryRun: false }),
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: 'App inbox entry did not complete within the wait budget',
  });
});

function createApp(
  options:
    & Partial<
      Omit<adminOperationsRoutes.AdminOperationsRouteDependencies, 'operations'>
    >
    & {
      operations?: Partial<adminOperationsRoutes.AdminOperationsServiceLike>;
    } = {},
): Hono {
  const app = new Hono();
  const { operations, ...routeOptions } = options;
  adminOperationsRoutes.init(app, {
    adminClientIds: ['platform-admin'],
    requireApiAuthSession: () => Promise.resolve(ADMIN_SESSION),
    now: () => NOW_EPOCH_MS,
    operations: createOperations(operations),
    ...routeOptions,
  });
  return app;
}

function createOperations(
  overrides: Partial<adminOperationsRoutes.AdminOperationsServiceLike> = {},
): adminOperationsRoutes.AdminOperationsServiceLike {
  return {
    readOverview: () =>
      Promise.resolve({
        generatedAtEpochMs: NOW_EPOCH_MS,
        serverId: 'test-server',
        warnings: [],
        health: { status: 'ok' },
      }),
    readQueues: () => Promise.resolve({ generatedAtEpochMs: NOW_EPOCH_MS, warnings: [] }),
    readRealtime: () => Promise.resolve({ generatedAtEpochMs: NOW_EPOCH_MS, warnings: [] }),
    readState: (input: { scope?: unknown }) =>
      Promise.resolve({
        generatedAtEpochMs: NOW_EPOCH_MS,
        warnings: [],
        scope: input.scope,
      }),
    readCrdt: (input: { scope?: unknown }) =>
      Promise.resolve({
        generatedAtEpochMs: NOW_EPOCH_MS,
        warnings: [],
        scope: input.scope,
      }),
    readSystem: () => Promise.resolve({ generatedAtEpochMs: NOW_EPOCH_MS, warnings: [] }),
    resetMetrics: () =>
      Promise.resolve({
        generatedAtEpochMs: NOW_EPOCH_MS,
        warnings: [],
        operation: 'metrics.reset',
        status: 'completed',
        changed: false,
      }),
    recomputeTopology: () =>
      Promise.resolve({
        generatedAtEpochMs: NOW_EPOCH_MS,
        warnings: [],
        operation: 'topology.recompute',
        status: 'completed',
        changed: false,
      }),
    pruneExpired: () =>
      Promise.resolve({
        generatedAtEpochMs: NOW_EPOCH_MS,
        warnings: [],
        operation: 'maintenance.prune-expired',
        status: 'dry-run',
        changed: false,
      }),
    verifyCrdtIntegrity: () => Promise.resolve({ generatedAtEpochMs: NOW_EPOCH_MS, warnings: [] }),
    exportCrdtDebug: () => Promise.resolve({ generatedAtEpochMs: NOW_EPOCH_MS, warnings: [] }),
    compactCrdt: () => Promise.resolve({ generatedAtEpochMs: NOW_EPOCH_MS, warnings: [] }),
    updateCrdtLifecycle: () => Promise.resolve({ generatedAtEpochMs: NOW_EPOCH_MS, warnings: [] }),
    eraseCrdt: () => Promise.resolve({ generatedAtEpochMs: NOW_EPOCH_MS, warnings: [] }),
    ...overrides,
  };
}
