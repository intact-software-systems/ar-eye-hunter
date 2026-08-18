import assert from 'node:assert/strict';

import {
  createGroupStateRouteSnapshot,
  createGroupStateRouteTestRuntime,
  createPredecessorGroupStateRouteAuthSession,
  createPredecessorGroupStateRouteSnapshot,
  createPredecessorGroupStateRouteTestRuntime,
} from './group-state-route-test-runtime.ts';

const API_BASE = '/api/state/apps/app-1/workspaces/workspace-1/groups';
const GROUP_STATE_ROUTE_BASE = '/api/state/apps/:applicationId/workspaces/:workspaceId/groups';
const GROUP_ROUTE_PATH = `${GROUP_STATE_ROUTE_BASE}/:groupId`;

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

Deno.test(
  'group state route registration retains all 24 Hono handlers in predecessor order',
  () => {
    const runtime = createGroupStateRouteTestRuntime({ installStateAuthentication: false });
    const registeredRoutes = (runtime.app as unknown as {
      readonly routes: readonly { readonly method: string; readonly path: string }[];
    }).routes.map((route) => `${route.method} ${route.path}`);

    assert.deepEqual(registeredRoutes, [
      `GET ${GROUP_STATE_ROUTE_BASE}`,
      `GET ${GROUP_ROUTE_PATH}`,
      `GET ${GROUP_ROUTE_PATH}/events`,
      `GET ${GROUP_ROUTE_PATH}/events/page`,
      `POST ${GROUP_STATE_ROUTE_BASE}`,
      `PUT ${GROUP_ROUTE_PATH}`,
      `POST ${GROUP_ROUTE_PATH}/director/appoint`,
      `POST ${GROUP_ROUTE_PATH}/lifecycle/establish`,
      `POST ${GROUP_ROUTE_PATH}/lifecycle/activate`,
      `POST ${GROUP_ROUTE_PATH}/lifecycle/reopen`,
      `POST ${GROUP_ROUTE_PATH}/join`,
      `POST ${GROUP_ROUTE_PATH}/invites/accept`,
      `POST ${GROUP_ROUTE_PATH}/join-code/rotate`,
      `POST ${GROUP_ROUTE_PATH}/invites/:principalId`,
      `POST ${GROUP_ROUTE_PATH}/invites/:principalId/revoke`,
      `POST ${GROUP_ROUTE_PATH}/members/:principalId/remove`,
      `POST ${GROUP_ROUTE_PATH}/members/:principalId/ban`,
      `POST ${GROUP_ROUTE_PATH}/members/:principalId/unban`,
      `PUT ${GROUP_ROUTE_PATH}/members/:principalId/role`,
      `POST ${GROUP_ROUTE_PATH}/owner/transfer`,
      `PUT ${GROUP_ROUTE_PATH}/members/:principalId`,
      `PUT ${GROUP_ROUTE_PATH}/sessions/:sessionId`,
      `POST ${GROUP_ROUTE_PATH}/sessions/:sessionId/heartbeat`,
      `POST ${GROUP_ROUTE_PATH}/sessions/:sessionId/disconnect`,
    ]);
  },
);

Deno.test(
  'group state route registration matches all 21 public method and path contracts',
  async () => {
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
  },
);

Deno.test('moved group route auth retains predecessor token and timing shape', () => {
  const before = Date.now();
  const session = createPredecessorGroupStateRouteAuthSession('alice');
  const after = Date.now();

  assert.equal(session.accessToken, 'token');
  assert.ok(session.issuedAtEpochMs >= before - 1_000);
  assert.ok(session.issuedAtEpochMs <= after - 1_000);
  assert.ok(session.expiresAtEpochMs >= before + 60_000);
  assert.ok(session.expiresAtEpochMs <= after + 60_000);
});

Deno.test('moved group snapshots retain first-active-principal ownership', () => {
  const snapshot = createPredecessorGroupStateRouteSnapshot('room-2', ['bob']);

  assert.equal(snapshot.group.ownerPrincipalId, 'bob');
  assert.equal(snapshot.members[0]?.role, 'owner');
});

Deno.test('moved group route runtime rejects unexpected mutations by default', async () => {
  const { app } = createPredecessorGroupStateRouteTestRuntime();
  const response = await app.request(API_BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      groupId: 'room-2',
      displayName: 'Room 2',
      kind: 'room',
      requestId: 'unexpected-mutation',
    }),
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Unexpected group mutation/);
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
