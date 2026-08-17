import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import type { AuthSession } from '@shared/api/api-config.ts';
import type {
  GroupSpaStatisticsResponse,
  MyRealtimeSpaStatisticsResponse,
  WorkspaceSpaStatisticsResponse,
} from '@shared/api/spa-statistics-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-policy.ts';
import * as spaStatisticsRoutes from '../../src/routes/spa-statistics-routes.ts';

const NOW_EPOCH_MS = 1_700_000_000_000;
const TEST_SCOPE: StateScope = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
};
const AUTH_SESSION: AuthSession = {
  clientId: 'alice',
  username: 'alice',
  accessToken: 'alice-token',
  sessionId: 'alice-session',
  expiresAtEpochMs: NOW_EPOCH_MS + 60_000,
};

Deno.test('SPA statistics routes require route-local auth for workspace stats', async () => {
  let serviceCalled = false;
  const app = createApp({
    requireApiAuthSession: () => Promise.reject(new Error('Unauthorized: Missing bearer token')),
    statistics: {
      readWorkspaceSummary: () => {
        serviceCalled = true;
        return Promise.resolve(createWorkspaceSummary());
      },
    },
  });

  const response = await app.request(
    '/api/state/apps/app-1/workspaces/workspace-1/stats/summary',
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: 'Unauthorized: Missing bearer token',
  });
  assert.equal(serviceCalled, false);
});

Deno.test('SPA statistics workspace route forwards scope and disables response caching', async () => {
  const calls: unknown[] = [];
  const app = createApp({
    statistics: {
      readWorkspaceSummary: (input: unknown) => {
        calls.push(input);
        return Promise.resolve(createWorkspaceSummary());
      },
    },
  });

  const response = await app.request(
    '/api/state/apps/app-1/workspaces/workspace-1/stats/summary',
    {
      headers: {
        authorization: 'Bearer alice-token',
        'x-client-id': 'alice',
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), createWorkspaceSummary());
  assert.deepEqual(calls, [
    {
      scope: TEST_SCOPE,
      authSession: AUTH_SESSION,
    },
  ]);
});

Deno.test('SPA statistics group route preserves group policy error payloads', async () => {
  const app = createApp({
    statistics: {
      readGroupStats: () =>
        Promise.reject(
          new GroupPolicyDeniedError({
            allowed: false,
            code: 'group-policy-denied',
            message: 'Only active group members can read full group state.',
            details: { visibility: 'directory' },
          }),
        ),
    },
  });

  const response = await app.request(
    '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/stats',
    {
      headers: {
        authorization: 'Bearer alice-token',
        'x-client-id': 'alice',
      },
    },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: 'Forbidden: Only active group members can read full group state.',
    code: 'group-policy-denied',
    message: 'Only active group members can read full group state.',
    details: { visibility: 'directory' },
  });
});

Deno.test('SPA statistics group route forwards scoped group refs', async () => {
  const calls: unknown[] = [];
  const app = createApp({
    statistics: {
      readGroupStats: (input: unknown) => {
        calls.push(input);
        return Promise.resolve(createGroupStats('room /1'));
      },
    },
  });

  const response = await app.request(
    '/api/state/apps/app-1/workspaces/workspace-1/groups/room%20%2F1/stats',
    {
      headers: {
        authorization: 'Bearer alice-token',
        'x-client-id': 'alice',
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).groupRef, {
    ...TEST_SCOPE,
    groupId: 'room /1',
  });
  assert.deepEqual(calls, [
    {
      scope: TEST_SCOPE,
      groupId: 'room /1',
      authSession: AUTH_SESSION,
    },
  ]);
});

Deno.test('SPA statistics my realtime route returns self-only readiness status', async () => {
  const app = createApp({
    statistics: {
      readMyRealtimeStatus: () => Promise.resolve(createMyRealtimeStatus()),
    },
  });

  const response = await app.request(
    '/api/state/apps/app-1/workspaces/workspace-1/stats/me/realtime',
    {
      headers: {
        authorization: 'Bearer alice-token',
        'x-client-id': 'alice',
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), createMyRealtimeStatus());
});

function createApp(
  options:
    & Partial<Omit<spaStatisticsRoutes.SpaStatisticsRouteDependencies, 'statistics'>>
    & {
      statistics?: Partial<spaStatisticsRoutes.SpaStatisticsRouteService>;
    } = {},
): Hono {
  const app = new Hono();
  const { statistics, ...routeOptions } = options;
  spaStatisticsRoutes.registerSpaStatisticsRoutes(app, {
    requireApiAuthSession: () => Promise.resolve(AUTH_SESSION),
    statistics: createStatistics(statistics),
    ...routeOptions,
  });
  return app;
}

function createStatistics(
  overrides: Partial<spaStatisticsRoutes.SpaStatisticsRouteService> = {},
): spaStatisticsRoutes.SpaStatisticsRouteService {
  return {
    readWorkspaceSummary: () => Promise.resolve(createWorkspaceSummary()),
    readGroupStats: () => Promise.resolve(createGroupStats('room-1')),
    readMyRealtimeStatus: () => Promise.resolve(createMyRealtimeStatus()),
    ...overrides,
  };
}

function createWorkspaceSummary(): WorkspaceSpaStatisticsResponse {
  return {
    generatedAtEpochMs: NOW_EPOCH_MS,
    scope: TEST_SCOPE,
    actor: {
      principalId: 'alice',
      sessionId: 'alice-session',
      activeClientSessionCount: 1,
      groupPresenceCount: 1,
    },
    warnings: [],
    groups: {
      fullReadableCount: 1,
      joinedCount: 1,
      onlineMemberCount: 1,
    },
    activity: {
      recentVisibleGroupEventCount: {
        count: 0,
        limit: 20,
        bounded: true,
      },
    },
    topGroups: [],
  };
}

function createGroupStats(groupId: string): GroupSpaStatisticsResponse {
  return {
    generatedAtEpochMs: NOW_EPOCH_MS,
    scope: TEST_SCOPE,
    groupRef: {
      ...TEST_SCOPE,
      groupId,
    },
    actor: {
      principalId: 'alice',
      sessionId: 'alice-session',
      role: 'member',
      activePresenceSessionCount: 1,
    },
    warnings: [],
    group: {
      groupId,
      displayName: 'Room 1',
      kind: 'room',
      status: 'active',
      joinMode: 'invite-only',
      snapshotVersion: 1,
      presenceVersion: 1,
      memberCount: 1,
      onlineMemberCount: 1,
      activeSessionCount: 1,
    },
    activity: {
      recentGroupEventCount: {
        count: 0,
        limit: 20,
        bounded: true,
      },
    },
  };
}

function createMyRealtimeStatus(): MyRealtimeSpaStatisticsResponse {
  return {
    generatedAtEpochMs: NOW_EPOCH_MS,
    scope: TEST_SCOPE,
    actor: {
      principalId: 'alice',
      sessionId: 'alice-session',
    },
    warnings: [
      {
        code: 'process-local-realtime',
        message: 'WebSocket status is process-local.',
      },
    ],
    realtime: {
      processLocal: true,
      currentSessionOpen: true,
    },
    clientState: {
      activeClientSessionCount: 1,
      currentSessionInClientState: true,
    },
    groupPresence: {
      activeGroupPresenceCount: 0,
      groups: [],
    },
  };
}
