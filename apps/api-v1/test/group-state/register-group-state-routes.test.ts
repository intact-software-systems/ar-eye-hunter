import assert from 'node:assert/strict';

import {
  createGroupStateRouteSnapshot,
  createGroupStateRouteTestRuntime,
} from './group-state-route-test-runtime.ts';

const API_BASE = '/api/state/apps/app-1/workspaces/workspace-1/groups';

interface GroupStateRouteMatch {
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly path: string;
  readonly body?: Record<string, unknown>;
  readonly status: 200 | 201;
}

const GROUP_STATE_ROUTE_MATCHES: readonly GroupStateRouteMatch[] = [
  { method: 'GET', path: API_BASE, status: 200 },
  {
    method: 'POST',
    path: API_BASE,
    body: { groupId: 'room-1', displayName: 'Room', kind: 'room' },
    status: 201,
  },
  { method: 'GET', path: `${API_BASE}/room-1`, status: 200 },
  { method: 'PUT', path: `${API_BASE}/room-1`, body: { displayName: 'Room' }, status: 200 },
  { method: 'GET', path: `${API_BASE}/room-1/events`, status: 200 },
  { method: 'GET', path: `${API_BASE}/room-1/events/page`, status: 200 },
  {
    method: 'POST',
    path: `${API_BASE}/room-1/director/appoint`,
    body: { heartbeatTtlMs: 1 },
    status: 200,
  },
  { method: 'POST', path: `${API_BASE}/room-1/join`, body: {}, status: 200 },
  { method: 'POST', path: `${API_BASE}/room-1/invites/accept`, body: {}, status: 200 },
  {
    method: 'POST',
    path: `${API_BASE}/room-1/join-code/rotate`,
    body: { joinCode: 'next', expiresAtEpochMs: 1 },
    status: 200,
  },
  {
    method: 'POST',
    path: `${API_BASE}/room-1/invites/bob`,
    body: { invitationExpiresAtEpochMs: 1 },
    status: 200,
  },
  { method: 'POST', path: `${API_BASE}/room-1/invites/bob/revoke`, body: {}, status: 200 },
  { method: 'POST', path: `${API_BASE}/room-1/members/bob/remove`, body: {}, status: 200 },
  { method: 'POST', path: `${API_BASE}/room-1/members/bob/ban`, body: {}, status: 200 },
  { method: 'POST', path: `${API_BASE}/room-1/members/bob/unban`, body: {}, status: 200 },
  {
    method: 'PUT',
    path: `${API_BASE}/room-1/members/bob/role`,
    body: { role: 'admin' },
    status: 200,
  },
  {
    method: 'POST',
    path: `${API_BASE}/room-1/owner/transfer`,
    body: { newOwnerPrincipalId: 'bob' },
    status: 200,
  },
  {
    method: 'PUT',
    path: `${API_BASE}/room-1/members/alice`,
    body: { status: 'active' },
    status: 200,
  },
  {
    method: 'PUT',
    path: `${API_BASE}/room-1/sessions/alice-session`,
    body: {
      generationId: 'generation',
      connectedAtEpochMs: 1,
      lastHeartbeatAtEpochMs: 1,
      expiresAtEpochMs: 1,
    },
    status: 200,
  },
  {
    method: 'POST',
    path: `${API_BASE}/room-1/sessions/alice-session/heartbeat`,
    body: { generationId: 'generation', lastHeartbeatAtEpochMs: 1, expiresAtEpochMs: 1 },
    status: 200,
  },
  {
    method: 'POST',
    path: `${API_BASE}/room-1/sessions/alice-session/disconnect`,
    body: {
      generationId: 'generation',
      lastHeartbeatAtEpochMs: 1,
      disconnectedAtEpochMs: 1,
      expiresAtEpochMs: 1,
    },
    status: 200,
  },
];

Deno.test('group state route registration retains all 21 Hono handlers in predecessor order', () => {
  const runtime = createGroupStateRouteTestRuntime({ installStateAuthentication: false });
  const registeredRoutes = (runtime.app as unknown as {
    readonly routes: readonly { readonly method: string; readonly path: string }[];
  }).routes.map((route) => `${route.method} ${route.path}`);

  assert.deepEqual(registeredRoutes, [
    'GET /api/state/apps/:applicationId/workspaces/:workspaceId/groups',
    'GET /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId',
    'GET /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/events',
    'GET /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/events/page',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups',
    'PUT /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/director/appoint',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/join',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/invites/accept',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/join-code/rotate',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/invites/:principalId',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/invites/:principalId/revoke',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/members/:principalId/remove',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/members/:principalId/ban',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/members/:principalId/unban',
    'PUT /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/members/:principalId/role',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/owner/transfer',
    'PUT /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/members/:principalId',
    'PUT /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/sessions/:sessionId',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/sessions/:sessionId/heartbeat',
    'POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/sessions/:sessionId/disconnect',
  ]);
});

Deno.test('group state route registration matches all 21 public method and path contracts', async () => {
  const snapshot = createGroupStateRouteSnapshot('room-1', ['alice', 'bob']);
  const runtime = createGroupStateRouteTestRuntime({
    groupService: {
      readSnapshot: () => Promise.resolve(snapshot),
      readCurrentSnapshot: () => Promise.resolve(snapshot),
    },
  });

  for (const expected of GROUP_STATE_ROUTE_MATCHES) {
    const response = await requestRegisteredGroupStateRoute(runtime.app, expected);
    assert.equal(response.status, expected.status, `${expected.method} ${expected.path}`);
  }
});

async function requestRegisteredGroupStateRoute(
  app: ReturnType<typeof createGroupStateRouteTestRuntime>['app'],
  expected: GroupStateRouteMatch,
): Promise<Response> {
  return await app.request(expected.path, {
    method: expected.method,
    headers: expected.body ? { 'content-type': 'application/json' } : undefined,
    body: expected.body ? JSON.stringify(expected.body) : undefined,
  });
}
