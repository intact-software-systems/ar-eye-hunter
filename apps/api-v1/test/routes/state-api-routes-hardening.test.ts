import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { AuditStamp, ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupMember, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-policy.ts';
import type { ClientStateWritten } from '@shared-server/rallar-system/services/client-state-service.ts';
import { Either } from '@shared/resilience/Either.ts';
import {
  type AppInboxEnqueueInput,
  AppInboxType,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import * as clientStateRoutes from '../../src/routes/client-state-routes.ts';
import * as groupStateRoutes from '../../src/routes/group-state-routes.ts';

const TEST_SCOPE: StateScope = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
};

Deno.test('non-strict state read routes preserve authenticated non-self client reads', async () => {
  await withStrictReadAuth(false, async () => {
    const snapshot = createClientSnapshot('bob');
    const deps = createClientRouteDeps({
      session: createAuthSession('alice'),
      clientService: {
        readSnapshot: () => Promise.resolve(snapshot),
      },
    });
    const app = createClientRouteApp(deps);

    const response = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/clients/bob',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), snapshot);
    assert.equal(deps.authCallCount(), 1);
  });
});

Deno.test('malformed client REST mutations return terminal 400 before inbox enqueue', async () => {
  const processCalls: unknown[] = [];
  const deps = createClientRouteDeps({
    session: createAuthSession('alice'),
    clientService: {},
    processClientAppInbox: (input) => {
      processCalls.push(input);
      return Promise.resolve(toClientStateWritten(createClientSnapshot('alice')));
    },
  });
  const app = createClientRouteApp(deps);
  const base = '/api/state/apps/app-1/workspaces/workspace-1/clients/alice';
  const cases = [
    {
      method: 'PUT',
      path: `${base}/principal`,
      body: { username: '', status: 'unknown' },
    },
    {
      method: 'PUT',
      path: `${base}/instances/browser`,
      body: { capabilities: [42] },
    },
    {
      method: 'PUT',
      path: `${base}/instances/browser/sessions/alice-session`,
      body: { generationId: { forged: true } },
    },
    {
      method: 'PUT',
      path: `${base}/instances/browser/sessions/alice-session`,
      body: {
        generationId: 'generation-1',
        connectedAtEpochMs: 2,
        lastHeartbeatAtEpochMs: 1,
      },
    },
    {
      method: 'POST',
      path: `${base}/instances/browser/sessions/alice-session/heartbeat`,
      body: { generationId: 'generation-1', lastHeartbeatAtEpochMs: -1 },
    },
    {
      method: 'POST',
      path: `${base}/instances/browser/sessions/alice-session/heartbeat`,
      body: {
        generationId: 'generation-1',
        lastHeartbeatAtEpochMs: 2,
        expiresAtEpochMs: 1,
      },
    },
    {
      method: 'POST',
      path: `${base}/instances/browser/sessions/alice-session/disconnect`,
      body: {},
    },
    {
      method: 'POST',
      path: `${base}/instances/browser/sessions/alice-session/disconnect`,
      body: {
        generationId: 'generation-1',
        disconnectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 2,
      },
    },
  ] as const;

  for (const testCase of cases) {
    const response = await app.request(testCase.path, {
      method: testCase.method,
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(testCase.body),
    });
    assert.equal(response.status, 400, testCase.path);
    assert.match((await response.json()).error, /Client|client/);
  }
  assert.equal(processCalls.length, 0);
});

Deno.test('client REST lifecycle accepts equal causal timestamp boundaries', async () => {
  const processCalls: unknown[] = [];
  const deps = createClientRouteDeps({
    session: createAuthSession('alice'),
    clientService: {},
    processClientAppInbox: (input) => {
      processCalls.push(input);
      return Promise.resolve(toClientStateWritten(createClientSnapshot('alice')));
    },
  });
  const app = createClientRouteApp(deps);
  const session =
    '/api/state/apps/app-1/workspaces/workspace-1/clients/alice/instances/browser/sessions/alice-session';
  const cases = [
    {
      method: 'PUT',
      path: session,
      body: {
        generationId: 'generation-connect',
        authenticatedAtEpochMs: 1,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 1,
      },
    },
    {
      method: 'POST',
      path: `${session}/heartbeat`,
      body: {
        generationId: 'generation-heartbeat',
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 1,
      },
    },
    {
      method: 'POST',
      path: `${session}/disconnect`,
      body: {
        generationId: 'generation-disconnect',
        disconnectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 1,
      },
    },
  ] as const;

  for (const testCase of cases) {
    const response = await app.request(testCase.path, {
      method: testCase.method,
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(testCase.body),
    });
    assert.equal(response.status, 200, testCase.path);
  }
  assert.equal(processCalls.length, 3);
});

Deno.test('group REST presence lifecycle requires a valid generation before enqueue', async () => {
  const processCalls: unknown[] = [];
  const snapshot = createGroupSnapshot('room-1', ['alice']);
  const deps = createGroupRouteDeps({
    session: createAuthSession('alice'),
    groupService: {
      readCurrentSnapshot: () => Promise.resolve(snapshot),
    },
    processGroupAppInbox: (_authority, input) => {
      processCalls.push(input);
      return Promise.resolve({
        outcome: 'applied',
        causalRevision: snapshot.causalRevision,
      } as never);
    },
  });
  const app = createGroupRouteApp(deps);
  const session =
    '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/sessions/alice-session';
  const malformed = [
    { method: 'PUT', path: session, body: {} },
    {
      method: 'POST',
      path: `${session}/heartbeat`,
      body: { generationId: { forged: true } },
    },
    {
      method: 'POST',
      path: `${session}/heartbeat`,
      body: { generationId: 'generation-1', lastHeartbeatAtEpochMs: -1 },
    },
    {
      method: 'POST',
      path: `${session}/disconnect`,
      body: {
        generationId: 'generation-1',
        lastHeartbeatAtEpochMs: 2,
        disconnectedAtEpochMs: 1,
      },
    },
  ] as const;
  for (const testCase of malformed) {
    const response = await app.request(testCase.path, {
      method: testCase.method,
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(testCase.body),
    });
    assert.equal(response.status, 400, testCase.path);
    assert.match((await response.json()).error, /Group|group/);
  }
  assert.equal(processCalls.length, 0);

  for (
    const testCase of [
      { method: 'PUT', path: session },
      { method: 'POST', path: `${session}/heartbeat` },
      { method: 'POST', path: `${session}/disconnect` },
    ] as const
  ) {
    const response = await app.request(testCase.path, {
      method: testCase.method,
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        generationId: 'generation-1',
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 1,
        ...(testCase.path.endsWith('/disconnect') ? { disconnectedAtEpochMs: 1 } : {}),
      }),
    });
    assert.equal(response.status, 200, testCase.path);
  }
  assert.equal(processCalls.length, 3);
});

Deno.test('all non-presence group REST mutations reject malformed bodies before inbox enqueue', async () => {
  const processCalls: unknown[] = [];
  const snapshot = createGroupSnapshot('room-1', ['alice']);
  const ownerSnapshot: GroupSnapshot = {
    ...snapshot,
    members: snapshot.members.map((member) => ({ ...member, role: 'owner' as const })),
  };
  const deps = createGroupRouteDeps({
    session: createAuthSession('alice'),
    groupService: {
      readSnapshot: () => Promise.resolve(ownerSnapshot),
    },
    processGroupAppInbox: (_authority, input) => {
      processCalls.push(input);
      return Promise.reject(new Error('Malformed request reached group inbox'));
    },
  });
  const app = createGroupRouteApp(deps);
  const base = '/api/state/apps/app-1/workspaces/workspace-1/groups';
  const group = `${base}/room-1`;
  const cases = [
    { method: 'POST', path: base, body: { displayName: 7, kind: 'room', groupId: 'room-2' } },
    { method: 'PUT', path: group, body: { status: 'unknown' } },
    { method: 'POST', path: `${group}/director/appoint`, body: { heartbeatTtlMs: 0 } },
    { method: 'POST', path: `${group}/join`, body: { inviteToken: 7 } },
    { method: 'POST', path: `${group}/invites/accept`, body: { reason: 7 } },
    {
      method: 'POST',
      path: `${group}/join-code/rotate`,
      body: { joinCode: '', expiresAtEpochMs: 0 },
    },
    {
      method: 'POST',
      path: `${group}/invites/bob`,
      body: { invitationExpiresAtEpochMs: -1 },
    },
    { method: 'POST', path: `${group}/invites/bob/revoke`, body: { traceId: 7 } },
    { method: 'POST', path: `${group}/members/bob/remove`, body: { reason: {} } },
    { method: 'POST', path: `${group}/members/bob/ban`, body: { requestId: {} } },
    { method: 'POST', path: `${group}/members/bob/unban`, body: { traceId: [] } },
    { method: 'PUT', path: `${group}/members/bob/role`, body: { role: 'superuser' } },
    { method: 'POST', path: `${group}/owner/transfer`, body: { newOwnerPrincipalId: '' } },
    {
      method: 'PUT',
      path: `${group}/members/alice`,
      body: { status: 'active', invitationExpiresAtEpochMs: -1 },
    },
  ] as const;

  for (const testCase of cases) {
    const response = await app.request(testCase.path, {
      method: testCase.method,
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(testCase.body),
    });
    assert.equal(response.status, 400, `${testCase.method} ${testCase.path}`);
    assert.match((await response.json()).error, /Group|group/);
  }
  assert.equal(processCalls.length, 0);
});

Deno.test('client REST mutation preserves explicit terminal idempotency 409', async () => {
  const conflict = Object.assign(
    new Error('Client mutation command differs for request same-request'),
    {
      code: 'client-mutation-idempotency-conflict',
      status: 409,
    },
  );
  let processCount = 0;
  const deps = createClientRouteDeps({
    session: createAuthSession('alice'),
    clientService: {},
    processClientAppInbox: () => {
      processCount += 1;
      return Promise.reject(conflict);
    },
  });
  const response = await createClientRouteApp(deps).request(
    '/api/state/apps/app-1/workspaces/workspace-1/clients/alice/principal',
    {
      method: 'PUT',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        requestId: 'same-request',
        username: 'alice',
        metadata: { beta: 2, alpha: 1 },
      }),
    },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: 'Client mutation command differs for request same-request',
  });
  assert.equal(processCount, 1);
});

Deno.test('client route adapter preserves a base-era AppInbox status code and message', async () => {
  const toClientError = (
    clientStateRoutes as
      & typeof clientStateRoutes
      & Readonly<{
        toClientAppInboxError?: (failure: string) => Error;
      }>
  ).toClientAppInboxError;
  assert.ok(toClientError);
  const failure = JSON.stringify({
    error: 'Client mutation rejected',
    code: 'client-mutation-rejected',
    message: 'Client mutation rejected',
    status: 422,
  });
  const deps = createClientRouteDeps({
    session: createAuthSession('alice'),
    clientService: {},
    processClientAppInbox: () => Promise.reject(toClientError(failure)),
  });

  const response = await createClientRouteApp(deps).request(
    '/api/state/apps/app-1/workspaces/workspace-1/clients/alice/principal',
    {
      method: 'PUT',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        requestId: 'legacy-client-failure',
        username: 'alice',
      }),
    },
  );

  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    error: 'Client mutation rejected',
    code: 'client-mutation-rejected',
  });
});

Deno.test('strict state read routes reject non-self client snapshot and event reads', async () => {
  await withStrictReadAuth(true, async () => {
    const deps = createClientRouteDeps({
      session: createAuthSession('alice'),
      clientService: {
        readSnapshot: () => Promise.resolve(createClientSnapshot('bob')),
        listEventPage: () =>
          Promise.resolve({
            events: [createClientEvent('bob-event')],
            hasMore: false,
          }),
      },
    });
    const app = createClientRouteApp(deps);

    const snapshotResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/clients/bob',
      { headers: { authorization: 'Bearer token' } },
    );
    const eventsResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/clients/bob/events/page',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(snapshotResponse.status, 403);
    assert.equal(eventsResponse.status, 403);
    assert.deepEqual(await snapshotResponse.json(), {
      error: 'Forbidden: state read principal id does not match authenticated client',
    });
  });
});

Deno.test('strict state read routes allow active group members and reject non-members', async () => {
  await withStrictReadAuth(true, async () => {
    const memberSnapshot = createGroupSnapshot('room-1', ['alice']);
    const nonMemberSnapshot = createGroupSnapshot('room-2', ['bob']);
    const deps = createGroupRouteDeps({
      session: createAuthSession('alice'),
      groupService: {
        readSnapshot: (ref: { groupId: string }) =>
          Promise.resolve(
            ref.groupId === 'room-1' ? memberSnapshot : nonMemberSnapshot,
          ),
      },
    });
    const app = createGroupRouteApp(deps);

    const allowed = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1',
      { headers: { authorization: 'Bearer token' } },
    );
    const denied = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-2',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), memberSnapshot);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'group-policy-denied');
  });
});

Deno.test('group snapshot reads probe durable state instead of trusting a warm cache', async () => {
  await withStrictReadAuth(false, async () => {
    const staleSnapshot = createGroupSnapshot('room-1', ['alice']);
    const currentSnapshot = createGroupSnapshot('room-1', ['alice', 'bob']);
    let cachedReadCount = 0;
    let currentReadCount = 0;
    const groupService = {
      readSnapshot: () => {
        cachedReadCount += 1;
        return Promise.resolve(staleSnapshot);
      },
      readCurrentSnapshot: () => {
        currentReadCount += 1;
        return Promise.resolve(currentSnapshot);
      },
    };
    const deps = createGroupRouteDeps({
      session: createAuthSession('alice'),
      groupService,
    });
    const app = createGroupRouteApp(deps);

    const response = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), currentSnapshot);
    assert.equal(cachedReadCount, 0);
    assert.equal(currentReadCount, 1);
  });
});

Deno.test('state read routes hydrate process snapshot caches after successful client and group REST reads', async () => {
  await withStrictReadAuth(false, async () => {
    const clientSnapshot = createClientSnapshot('alice');
    const groupSnapshot = createGroupSnapshot('room-1', ['alice']);
    const hydrationInputs: unknown[] = [];
    const clientDeps = createClientRouteDeps({
      session: createAuthSession('alice'),
      clientService: {
        listSnapshots: () => Promise.resolve([clientSnapshot]),
      },
      hydrateStateSyncSnapshotCaches: (input: unknown) => {
        hydrationInputs.push(input);
        return Promise.resolve({ clientSnapshotCount: 1, groupSnapshotCount: 0 });
      },
    });
    const groupDeps = createGroupRouteDeps({
      session: createAuthSession('alice'),
      groupService: {
        readSnapshot: () => Promise.resolve(groupSnapshot),
      },
      hydrateStateSyncSnapshotCaches: (input: unknown) => {
        hydrationInputs.push(input);
        return Promise.resolve({ clientSnapshotCount: 0, groupSnapshotCount: 1 });
      },
    });
    const app = new Hono();
    installAuthMiddleware(app, clientDeps.requireApiAuthSession);
    clientStateRoutes.init(app, clientDeps);
    groupStateRoutes.init(app, groupDeps);

    const clientsResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/clients',
      { headers: { authorization: 'Bearer token' } },
    );
    const groupResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(clientsResponse.status, 200);
    assert.equal(groupResponse.status, 200);
    assert.deepEqual(hydrationInputs, [
      { clients: [clientSnapshot] },
      { groups: [groupSnapshot] },
    ]);
  });
});

Deno.test('client mutation routes hydrate the receiving node cache from remotely processed results', async () => {
  const baseSnapshot = createClientSnapshot('alice');
  const snapshot: ClientSnapshot = {
    ...baseSnapshot,
    stateRevision: 3,
    principal: {
      ...baseSnapshot.principal,
      snapshotVersion: 3,
      presenceVersion: 2,
    },
    activeSessions: [{
      ...TEST_SCOPE,
      principalId: 'alice',
      clientInstanceId: 'instance-1',
      sessionId: 'alice-session',
      generationId: 'generation-1',
      generationVersion: 1,
      status: 'active',
      presenceState: 'online',
      transport: 'ws',
      connectionId: 'connection-1',
      authenticatedAtEpochMs: 1,
      connectedAtEpochMs: 1,
      lastHeartbeatAtEpochMs: 1,
      expiresAtEpochMs: 9_999_999_999_999,
      disconnectedAtEpochMs: null,
      disconnectReason: null,
    }],
    isOnline: true,
    activeSessionCount: 1,
    lastSeenAtEpochMs: 1,
  };
  const hydrationInputs: unknown[] = [];
  let cachedSnapshot = baseSnapshot;
  const app = new Hono();
  clientStateRoutes.init(app, {
    getClientStateService: () => ({
      listSnapshots: () => Promise.resolve([]),
      readSnapshot: () => Promise.resolve(cachedSnapshot),
      readPresenceSnapshot: () => Promise.resolve(undefined),
      listEvents: () => Promise.resolve([]),
      listEventPage: () => Promise.resolve({ events: [], hasMore: false }),
    }),
    requireApiAuthSession: () => Promise.resolve(createAuthSession('alice')),
    processClientAppInbox: <V>(
      _input: AppInboxEnqueueInput<V>,
    ): Promise<ClientStateWritten> =>
      Promise.resolve({
        status: 'ok',
        result: Either.ofRight({ snapshot, event: null }),
      }),
    hydrateStateSyncSnapshotCaches: (input) => {
      hydrationInputs.push(input);
      cachedSnapshot = input.clients?.[0] ?? cachedSnapshot;
      return Promise.resolve({ clientSnapshotCount: 1, groupSnapshotCount: 0 });
    },
  });

  const response = await app.request(
    '/api/state/apps/app-1/workspaces/workspace-1/clients/alice/instances/instance-1/sessions/alice-session',
    {
      method: 'PUT',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        requestId: 'connect-alice-session',
        generationId: 'generation-1',
        authenticatedAtEpochMs: 1,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 9_999_999_999_999,
      }),
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), snapshot);
  assert.deepEqual(hydrationInputs, [{ clients: [snapshot] }]);

  const readResponse = await app.request(
    '/api/state/apps/app-1/workspaces/workspace-1/clients/alice',
    { headers: { authorization: 'Bearer token' } },
  );

  assert.equal(readResponse.status, 200);
  assert.deepEqual(await readResponse.json(), snapshot);
});

Deno.test('client mutation routes preserve committed success when cache hydration fails', async () => {
  const snapshot = createClientSnapshot('alice');
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const deps = createClientRouteDeps({
      session: createAuthSession('alice'),
      clientService: {},
      processClientAppInbox: () =>
        Promise.resolve({
          status: 'ok',
          result: Either.ofRight({ snapshot, event: null }),
        }),
      hydrateStateSyncSnapshotCaches: () =>
        Promise.reject(new Error('local cache observer failed')),
    });
    const app = createClientRouteApp(deps);

    const response = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/clients/alice/principal',
      {
        method: 'PUT',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          requestId: 'upsert-alice-principal',
          username: 'alice',
        }),
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), snapshot);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.[0], 'Failed to hydrate client mutation snapshot cache');
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test('state event page routes call paged services instead of full-history listEvents', async () => {
  await withStrictReadAuth(false, async () => {
    const clientPage: StateEventPage<ClientEvent> = {
      events: [createClientEvent('client-event-1')],
      hasMore: false,
    };
    const groupPage: StateEventPage<GroupEvent> = {
      events: [createGroupEvent('group-event-1')],
      hasMore: false,
    };
    const clientDeps = createClientRouteDeps({
      session: createAuthSession('alice'),
      clientService: {
        listEvents: () => Promise.reject(new Error('full client history should not be loaded')),
        listEventPage: () => Promise.resolve(clientPage),
      },
    });
    const groupDeps = createGroupRouteDeps({
      session: createAuthSession('alice'),
      groupService: {
        listEvents: () => Promise.reject(new Error('full group history should not be loaded')),
        listEventPage: () => Promise.resolve(groupPage),
      },
    });
    const app = new Hono();
    installAuthMiddleware(app, clientDeps.requireApiAuthSession);
    clientStateRoutes.init(app, clientDeps);
    groupStateRoutes.init(app, groupDeps);

    const clientResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/clients/alice/events/page?limit=10',
      { headers: { authorization: 'Bearer token' } },
    );
    const groupResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/events/page?limit=10',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(clientResponse.status, 200);
    assert.equal(groupResponse.status, 200);
    assert.deepEqual(await clientResponse.json(), clientPage);
    assert.deepEqual(await groupResponse.json(), groupPage);
  });
});

Deno.test('state event array routes call bounded recent services instead of full-history listEvents', async () => {
  await withStrictReadAuth(false, async () => {
    const clientEvent = createClientEvent('client-event-2');
    const groupEvent = createGroupEvent('group-event-2');
    const clientQueries: unknown[] = [];
    const groupQueries: unknown[] = [];
    const clientDeps = createClientRouteDeps({
      session: createAuthSession('alice'),
      clientService: {
        listEvents: () => Promise.reject(new Error('full client history should not be loaded')),
        listRecentEvents: (_ref, query) => {
          clientQueries.push(query);
          return Promise.resolve([clientEvent]);
        },
      },
    });
    const groupDeps = createGroupRouteDeps({
      session: createAuthSession('alice'),
      groupService: {
        listEvents: () => Promise.reject(new Error('full group history should not be loaded')),
        listRecentEvents: (_ref, query) => {
          groupQueries.push(query);
          return Promise.resolve([groupEvent]);
        },
      },
    });
    const app = new Hono();
    installAuthMiddleware(app, clientDeps.requireApiAuthSession);
    clientStateRoutes.init(app, clientDeps);
    groupStateRoutes.init(app, groupDeps);

    const clientResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/clients/alice/events?eventType=session-connected&limit=1',
      { headers: { authorization: 'Bearer token' } },
    );
    const groupResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/events?eventType=member-left&limit=1',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(clientResponse.status, 200);
    assert.equal(groupResponse.status, 200);
    assert.deepEqual(await clientResponse.json(), [clientEvent]);
    assert.deepEqual(await groupResponse.json(), [groupEvent]);
    assert.deepEqual(clientQueries, [{
      eventTypes: ['session-connected'],
      limit: 1,
    }]);
    assert.deepEqual(groupQueries, [{
      eventTypes: ['member-left'],
      limit: 1,
    }]);
  });
});

Deno.test('group state routes return stable policy error codes when available', async () => {
  await withStrictReadAuth(false, async () => {
    const deps = createGroupRouteDeps({
      session: createAuthSession('alice'),
      groupService: {
        listSnapshots: () =>
          Promise.reject(
            new GroupPolicyDeniedError({
              allowed: false,
              code: 'group-invite-required',
              message: 'Invite required.',
              details: { groupId: 'room-1' },
            }),
          ),
      },
    });
    const app = createGroupRouteApp(deps);

    const response = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: 'Forbidden: Invite required.',
      code: 'group-invite-required',
      message: 'Invite required.',
      details: { groupId: 'room-1' },
    });
  });
});

Deno.test('group mutation routes return stable lifecycle policy error codes', async () => {
  await withStrictReadAuth(false, async () => {
    const snapshot = createGroupSnapshot('room-1', ['alice']);
    const ownerSnapshot: GroupSnapshot = {
      ...snapshot,
      members: snapshot.members.map((member) =>
        member.principalId === 'alice' ? { ...member, role: 'owner' as const } : member
      ),
    };
    const deps = createGroupRouteDeps({
      session: createAuthSession('alice'),
      groupService: {
        readSnapshot: () => Promise.resolve(ownerSnapshot),
      },
      processGroupAppInbox: () =>
        Promise.reject(
          new GroupPolicyDeniedError({
            allowed: false,
            code: 'group-archived',
            message: 'Group is archived.',
            details: { groupId: 'room-1' },
          }),
        ),
    });
    const app = createGroupRouteApp(deps);

    const response = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1',
      {
        method: 'PUT',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ displayName: 'Renamed' }),
      },
    );

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: 'Forbidden: Group is archived.',
      code: 'group-archived',
      message: 'Group is archived.',
      details: { groupId: 'room-1' },
    });
  });
});

Deno.test('group route adapter reconstructs a legacy AppInbox policy denial with details', async () => {
  const toGroupError = (
    groupStateRoutes as
      & typeof groupStateRoutes
      & Readonly<{
        toGroupAppInboxError?: (failure: string) => Error;
      }>
  ).toGroupAppInboxError;
  assert.ok(toGroupError);
  const failure = JSON.stringify({
    error: 'Forbidden: Invite required.',
    code: 'group-invite-required',
    message: 'Invite required.',
    details: { groupId: 'room-1' },
  });
  const snapshot = createGroupSnapshot('room-1', ['alice']);
  const ownerSnapshot: GroupSnapshot = {
    ...snapshot,
    members: snapshot.members.map((member) =>
      member.principalId === 'alice' ? { ...member, role: 'owner' as const } : member
    ),
  };
  const deps = createGroupRouteDeps({
    session: createAuthSession('alice'),
    groupService: {
      readSnapshot: () => Promise.resolve(ownerSnapshot),
    },
    processGroupAppInbox: () => Promise.reject(toGroupError(failure)),
  });

  const response = await createGroupRouteApp(deps).request(
    '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1',
    {
      method: 'PUT',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        requestId: 'legacy-group-denial',
        displayName: 'Renamed',
      }),
    },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: 'Forbidden: Invite required.',
    code: 'group-invite-required',
    message: 'Invite required.',
    details: { groupId: 'room-1' },
  });
});

Deno.test('group join route enqueues explicit join intent with authenticated actor', async () => {
  await withStrictReadAuth(false, async () => {
    const snapshot = createGroupSnapshot('room-1', ['alice']);
    const enqueued: AppInboxEnqueueInput<unknown>[] = [];
    const deps = createGroupRouteDeps({
      session: createAuthSession('alice'),
      groupService: {},
      processGroupAppInbox: <V, R>(
        _authority: groupStateRoutes.GroupStateRouteAuthSession,
        input: AppInboxEnqueueInput<V>,
      ): Promise<R> => {
        enqueued.push(input);
        return Promise.resolve({
          status: 'ok',
          result: {
            right: {
              snapshot,
            },
          },
        } as R);
      },
    });
    const app = createGroupRouteApp(deps);

    const response = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/join',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          inviteToken: 'invite-1',
          joinCode: 'code-1',
          requestId: 'join-request-1',
        }),
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), snapshot);
    assert.equal(enqueued.length, 1);
    assert.deepEqual(enqueued[0], {
      type: AppInboxType.GROUP_JOIN,
      resourceId: 'join-request-1',
      contextId: 'app-1:workspace-1:room-1',
      senderId: 'alice',
      data: {
        scope: TEST_SCOPE,
        groupId: 'room-1',
        request: {
          inviteToken: 'invite-1',
          joinCode: 'code-1',
          actorPrincipalId: 'alice',
          actorSessionId: 'alice-session',
          requestId: 'join-request-1',
        },
      },
    });
  });
});

Deno.test('group invite routes enqueue safe invite workflows with authenticated actors', async () => {
  await withStrictReadAuth(false, async () => {
    const snapshot = createGroupSnapshot('room-1', ['alice']);
    const enqueued: AppInboxEnqueueInput<unknown>[] = [];
    const deps = createGroupRouteDeps({
      session: createAuthSession('alice'),
      groupService: {},
      processGroupAppInbox: <V, R>(
        _authority: groupStateRoutes.GroupStateRouteAuthSession,
        input: AppInboxEnqueueInput<V>,
      ): Promise<R> => {
        enqueued.push(input);
        return Promise.resolve({
          status: 'ok',
          result: {
            right: {
              snapshot,
            },
          },
        } as R);
      },
    });
    const app = createGroupRouteApp(deps);

    const createResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/invites/bob',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          invitationExpiresAtEpochMs: 2_000,
          requestId: 'invite-create-1',
        }),
      },
    );
    const revokeResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/invites/bob/revoke',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ requestId: 'invite-revoke-1' }),
      },
    );
    const acceptResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/invites/accept',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ requestId: 'invite-accept-1' }),
      },
    );

    assert.equal(createResponse.status, 200);
    assert.equal(revokeResponse.status, 200);
    assert.equal(acceptResponse.status, 200);
    assert.deepEqual(enqueued, [
      {
        type: AppInboxType.GROUP_INVITE_CREATE,
        resourceId: 'invite-create-1',
        contextId: 'app-1:workspace-1:room-1',
        senderId: 'alice',
        data: {
          scope: TEST_SCOPE,
          groupId: 'room-1',
          principalId: 'bob',
          request: {
            invitationExpiresAtEpochMs: 2_000,
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            requestId: 'invite-create-1',
          },
        },
      },
      {
        type: AppInboxType.GROUP_INVITE_REVOKE,
        resourceId: 'invite-revoke-1',
        contextId: 'app-1:workspace-1:room-1',
        senderId: 'alice',
        data: {
          scope: TEST_SCOPE,
          groupId: 'room-1',
          principalId: 'bob',
          request: {
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            requestId: 'invite-revoke-1',
          },
        },
      },
      {
        type: AppInboxType.GROUP_INVITE_ACCEPT,
        resourceId: 'invite-accept-1',
        contextId: 'app-1:workspace-1:room-1',
        senderId: 'alice',
        data: {
          scope: TEST_SCOPE,
          groupId: 'room-1',
          request: {
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            requestId: 'invite-accept-1',
          },
        },
      },
    ]);
  });
});

Deno.test('group join-code route enqueues rotation workflow with authenticated actor', async () => {
  await withStrictReadAuth(false, async () => {
    const snapshot = createGroupSnapshot('room-1', ['alice']);
    const responseBody = {
      joinCode: 'code-1',
      expiresAtEpochMs: 2_000,
      snapshot,
    };
    const enqueued: AppInboxEnqueueInput<unknown>[] = [];
    const deps = createGroupRouteDeps({
      session: createAuthSession('alice'),
      groupService: {},
      processGroupAppInbox: <V, R>(
        _authority: groupStateRoutes.GroupStateRouteAuthSession,
        input: AppInboxEnqueueInput<V>,
      ): Promise<R> => {
        enqueued.push(input);
        return Promise.resolve({
          status: 'ok',
          result: {
            right: responseBody,
          },
        } as R);
      },
    });
    const app = createGroupRouteApp(deps);

    const response = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/join-code/rotate',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          joinCode: 'code-1',
          expiresAtEpochMs: 2_000,
          requestId: 'rotate-code-1',
        }),
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), responseBody);
    assert.deepEqual(enqueued, [
      {
        type: AppInboxType.GROUP_JOIN_CODE_ROTATE,
        resourceId: 'rotate-code-1',
        contextId: 'app-1:workspace-1:room-1',
        senderId: 'alice',
        data: {
          scope: TEST_SCOPE,
          groupId: 'room-1',
          request: {
            joinCode: 'code-1',
            expiresAtEpochMs: 2_000,
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            requestId: 'rotate-code-1',
          },
        },
      },
    ]);
  });
});

Deno.test('group governance routes enqueue safe workflows with authenticated actors', async () => {
  await withStrictReadAuth(false, async () => {
    const snapshot = createGroupSnapshot('room-1', ['alice', 'bob']);
    const enqueued: AppInboxEnqueueInput<unknown>[] = [];
    const deps = createGroupRouteDeps({
      session: createAuthSession('alice'),
      groupService: {},
      processGroupAppInbox: <V, R>(
        _authority: groupStateRoutes.GroupStateRouteAuthSession,
        input: AppInboxEnqueueInput<V>,
      ): Promise<R> => {
        enqueued.push(input);
        return Promise.resolve({
          status: 'ok',
          result: {
            right: { snapshot },
          },
        } as R);
      },
    });
    const app = createGroupRouteApp(deps);

    const requests = [
      app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/members/bob/remove',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ requestId: 'remove-bob' }),
        },
      ),
      app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/members/bob/ban',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ requestId: 'ban-bob' }),
        },
      ),
      app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/members/bob/unban',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ requestId: 'unban-bob' }),
        },
      ),
      app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/members/bob/role',
        {
          method: 'PUT',
          headers: {
            authorization: 'Bearer token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ role: 'admin', requestId: 'role-bob' }),
        },
      ),
      app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/owner/transfer',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            newOwnerPrincipalId: 'bob',
            requestId: 'transfer-owner',
          }),
        },
      ),
    ];
    const responses = await Promise.all(requests);

    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), snapshot);
    }
    assert.deepEqual(enqueued, [
      {
        type: AppInboxType.GROUP_MEMBER_REMOVE,
        resourceId: 'remove-bob',
        contextId: 'app-1:workspace-1:room-1',
        senderId: 'alice',
        data: {
          scope: TEST_SCOPE,
          groupId: 'room-1',
          principalId: 'bob',
          request: {
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            requestId: 'remove-bob',
          },
        },
      },
      {
        type: AppInboxType.GROUP_MEMBER_BAN,
        resourceId: 'ban-bob',
        contextId: 'app-1:workspace-1:room-1',
        senderId: 'alice',
        data: {
          scope: TEST_SCOPE,
          groupId: 'room-1',
          principalId: 'bob',
          request: {
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            requestId: 'ban-bob',
          },
        },
      },
      {
        type: AppInboxType.GROUP_MEMBER_UNBAN,
        resourceId: 'unban-bob',
        contextId: 'app-1:workspace-1:room-1',
        senderId: 'alice',
        data: {
          scope: TEST_SCOPE,
          groupId: 'room-1',
          principalId: 'bob',
          request: {
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            requestId: 'unban-bob',
          },
        },
      },
      {
        type: AppInboxType.GROUP_MEMBER_ROLE_SET,
        resourceId: 'role-bob',
        contextId: 'app-1:workspace-1:room-1',
        senderId: 'alice',
        data: {
          scope: TEST_SCOPE,
          groupId: 'room-1',
          principalId: 'bob',
          request: {
            role: 'admin',
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            requestId: 'role-bob',
          },
        },
      },
      {
        type: AppInboxType.GROUP_OWNERSHIP_TRANSFER,
        resourceId: 'transfer-owner',
        contextId: 'app-1:workspace-1:room-1',
        senderId: 'alice',
        data: {
          scope: TEST_SCOPE,
          groupId: 'room-1',
          request: {
            newOwnerPrincipalId: 'bob',
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            requestId: 'transfer-owner',
          },
        },
      },
    ]);
  });
});

Deno.test('strict group reads reject banned members for snapshots and events', async () => {
  await withStrictReadAuth(true, async () => {
    const bannedSnapshot = createGroupSnapshotWithMember(
      'room-1',
      'alice',
      'banned',
    );
    const deps = createGroupRouteDeps({
      session: createAuthSession('alice'),
      groupService: {
        readSnapshot: () => Promise.resolve(bannedSnapshot),
        listEvents: () => Promise.reject(new Error('banned member read leaked')),
        listEventPage: () => Promise.reject(new Error('banned member read leaked')),
      },
    });
    const app = createGroupRouteApp(deps);

    const snapshotResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1',
      { headers: { authorization: 'Bearer token' } },
    );
    const eventsResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/events/page',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(snapshotResponse.status, 403);
    assert.equal(eventsResponse.status, 403);
    assert.equal((await snapshotResponse.json()).code, 'member-banned');
  });
});

Deno.test('strict group reads use shared full-state visibility policy', async () => {
  await withStrictReadAuth(true, async () => {
    const invitedSnapshot = createGroupSnapshotWithMember(
      'room-invited',
      'alice',
      'invited',
    );
    const deletedSnapshot = createDeletedGroupSnapshot('room-deleted', 'alice');
    const deps = createGroupRouteDeps({
      session: createAuthSession('alice'),
      groupService: {
        readSnapshot: (ref: { groupId: string }) =>
          Promise.resolve(
            ref.groupId === 'room-deleted' ? deletedSnapshot : invitedSnapshot,
          ),
        listEventPage: () =>
          Promise.resolve({
            events: [createGroupEvent('event-1')],
            hasMore: false,
          }),
      },
    });
    const app = createGroupRouteApp(deps);

    const invitedSnapshotResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-invited',
      { headers: { authorization: 'Bearer token' } },
    );
    const invitedEventsResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-invited/events/page',
      { headers: { authorization: 'Bearer token' } },
    );
    const deletedSnapshotResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-deleted',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(invitedSnapshotResponse.status, 403);
    assert.equal(invitedEventsResponse.status, 403);
    assert.equal(deletedSnapshotResponse.status, 403);
    assert.equal((await invitedSnapshotResponse.json()).code, 'group-policy-denied');
    assert.equal((await invitedEventsResponse.json()).code, 'group-policy-denied');
    assert.equal((await deletedSnapshotResponse.json()).code, 'group-deleted');
  });
});

function createClientRouteApp(
  deps: ReturnType<typeof createClientRouteDeps>,
): Hono {
  const app = new Hono();
  installAuthMiddleware(app, deps.requireApiAuthSession);
  clientStateRoutes.init(app, deps);
  return app;
}

function createGroupRouteApp(
  deps: ReturnType<typeof createGroupRouteDeps>,
): Hono {
  const app = new Hono();
  installAuthMiddleware(app, deps.requireApiAuthSession);
  groupStateRoutes.init(app, deps);
  return app;
}

function installAuthMiddleware(
  app: Hono,
  requireApiAuthSession: (
    req: { header(name: string): string | undefined },
  ) => Promise<Pick<AuthSession, 'clientId' | 'sessionId'>>,
): void {
  app.use('/api/state/*', async (c, next) => {
    await requireApiAuthSession(c.req);
    await next();
  });
}

function createClientRouteDeps(
  input: Readonly<{
    session: AuthSession & groupStateRoutes.GroupStateRouteAuthSession;
    clientService: Partial<clientStateRoutes.ClientStateRouteService>;
    hydrateStateSyncSnapshotCaches?: clientStateRoutes.ClientStateRouteDependencies[
      'hydrateStateSyncSnapshotCaches'
    ];
    processClientAppInbox?: clientStateRoutes.ClientStateRouteDependencies[
      'processClientAppInbox'
    ];
  }>,
):
  & Required<clientStateRoutes.ClientStateRouteDependencies>
  & Readonly<{
    authCallCount(): number;
  }> {
  let authCalls = 0;
  return {
    getClientStateService: () => ({
      listSnapshots: () => Promise.resolve([]),
      readSnapshot: () => Promise.resolve(undefined),
      readPresenceSnapshot: () => Promise.resolve(undefined),
      listEvents: () => Promise.resolve([]),
      listEventPage: () => Promise.resolve({ events: [], hasMore: false }),
      ...input.clientService,
    } as clientStateRoutes.ClientStateRouteService),
    requireApiAuthSession: () => {
      authCalls += 1;
      return Promise.resolve(input.session);
    },
    processClientAppInbox: input.processClientAppInbox ??
      (() => Promise.reject(new Error('Unexpected client mutation route call'))),
    hydrateStateSyncSnapshotCaches: input.hydrateStateSyncSnapshotCaches ??
      (() => Promise.resolve({ clientSnapshotCount: 0, groupSnapshotCount: 0 })),
    authCallCount: () => authCalls,
  };
}

function toClientStateWritten(snapshot: ClientSnapshot): ClientStateWritten {
  return {
    status: 'ok',
    result: Either.ofRight({ snapshot, event: null }),
  };
}

function createGroupRouteDeps(
  input: Readonly<{
    session: AuthSession & groupStateRoutes.GroupStateRouteAuthSession;
    groupService: Partial<groupStateRoutes.GroupStateRouteService>;
    hydrateStateSyncSnapshotCaches?: groupStateRoutes.GroupStateRouteDependencies[
      'hydrateStateSyncSnapshotCaches'
    ];
    processGroupAppInbox?: groupStateRoutes.GroupStateRouteDependencies[
      'processGroupAppInbox'
    ];
  }>,
): Required<groupStateRoutes.GroupStateRouteDependencies> {
  const readSnapshot = input.groupService.readSnapshot ??
    (() => Promise.resolve(undefined));

  return {
    getGroupStateService: () => ({
      listSnapshots: () => Promise.resolve([]),
      readSnapshot,
      readCurrentSnapshot: input.groupService.readCurrentSnapshot ?? readSnapshot,
      listEvents: () => Promise.resolve([]),
      listEventPage: () => Promise.resolve({ events: [], hasMore: false }),
      ...input.groupService,
    } as groupStateRoutes.GroupStateRouteService),
    requireApiAuthSession: () => Promise.resolve(input.session),
    processGroupAppInbox: input.processGroupAppInbox ??
      (() => Promise.reject(new Error('Unexpected group mutation route call'))),
    hydrateStateSyncSnapshotCaches: input.hydrateStateSyncSnapshotCaches ??
      (() => Promise.resolve({ clientSnapshotCount: 0, groupSnapshotCount: 0 })),
  };
}

async function withStrictReadAuth(
  enabled: boolean,
  action: () => Promise<void>,
): Promise<void> {
  const previous = Deno.env.get('RALLAR_STATE_STRICT_READ_AUTH');
  Deno.env.set('RALLAR_STATE_STRICT_READ_AUTH', enabled ? 'true' : 'false');
  try {
    await action();
  } finally {
    if (previous === undefined) {
      Deno.env.delete('RALLAR_STATE_STRICT_READ_AUTH');
    } else {
      Deno.env.set('RALLAR_STATE_STRICT_READ_AUTH', previous);
    }
  }
}

function createAuthSession(
  clientId: string,
): AuthSession & groupStateRoutes.GroupStateRouteAuthSession {
  return {
    clientId,
    accessToken: 'token',
    username: clientId,
    sessionId: `${clientId}-session`,
    issuedAtEpochMs: Date.now() - 1_000,
    expiresAtEpochMs: Date.now() + 60_000,
  };
}

function createClientSnapshot(principalId: string): ClientSnapshot {
  return {
    stateRevision: 1,
    principal: {
      ...TEST_SCOPE,
      principalId,
      username: principalId,
      displayName: principalId,
      avatarUrl: null,
      authProvider: null,
      externalSubjectId: null,
      status: 'active',
      roles: [],
      metadata: {},
      snapshotVersion: 1,
      profileVersion: 1,
      presenceVersion: 0,
      created: testAuditStamp(1),
      updated: testAuditStamp(1),
      disabled: null,
      deleted: null,
      lastSeenAtEpochMs: null,
    },
    instances: [],
    activeSessions: [],
    isOnline: false,
    activeSessionCount: 0,
    lastSeenAtEpochMs: null,
  };
}

function createGroupSnapshot(
  groupId: string,
  activePrincipalIds: readonly string[],
): GroupSnapshot {
  return {
    stateRevision: 1,
    causalRevision: { groupRevision: 1, presenceRevision: 0 },
    group: {
      ...TEST_SCOPE,
      groupId,
      slug: null,
      displayName: groupId,
      description: null,
      kind: 'room',
      status: 'active',
      joinMode: 'open',
      maxMembers: null,
      maxSessionsPerMember: null,
      metadata: {},
      activeMemberCount: activePrincipalIds.length,
      ownerPrincipalId: activePrincipalIds[0] ?? 'alice',
      snapshotVersion: 1,
      metadataVersion: 1,
      rosterVersion: 1,
      presenceVersion: 0,
      created: testAuditStamp(1),
      updated: testAuditStamp(1),
      expiresAtEpochMs: null,
      emptySinceEpochMs: null,
      purgeAfterEpochMs: null,
      archived: null,
      deleted: null,
    },
    members: activePrincipalIds.map((principalId): GroupMember => ({
      ...TEST_SCOPE,
      groupId,
      principalId,
      role: principalId === activePrincipalIds[0] ? 'owner' : 'member',
      status: 'active',
      joined: testAuditStamp(1),
      updated: testAuditStamp(1),
      left: null,
      removed: null,
      banned: null,
      invitedByPrincipalId: null,
      invitationExpiresAtEpochMs: null,
    })),
    activeSessions: [],
    memberCount: activePrincipalIds.length,
    onlineMemberCount: 0,
  };
}

function createGroupSnapshotWithMember(
  groupId: string,
  principalId: string,
  status: 'active' | 'invited' | 'left' | 'removed' | 'banned',
): GroupSnapshot {
  const snapshot = createGroupSnapshot(
    groupId,
    status === 'active' ? [principalId] : [],
  );
  const role: GroupMember['role'] = 'member';
  const common = {
    ...TEST_SCOPE,
    groupId,
    principalId,
    role,
    updated: testAuditStamp(1),
    invitedByPrincipalId: null,
    invitationExpiresAtEpochMs: null,
  };
  let member: GroupMember;
  if (status === 'invited') {
    member = {
      ...common,
      status,
      joined: null,
      left: null,
      removed: null,
      banned: null,
    };
  } else if (status === 'active') {
    member = {
      ...common,
      status,
      joined: testAuditStamp(1),
      left: null,
      removed: null,
      banned: null,
    };
  } else if (status === 'left') {
    member = {
      ...common,
      status,
      joined: testAuditStamp(1),
      left: testAuditStamp(1),
      removed: null,
      banned: null,
    };
  } else if (status === 'removed') {
    member = {
      ...common,
      status,
      joined: testAuditStamp(1),
      left: null,
      removed: testAuditStamp(1),
      banned: null,
    };
  } else {
    member = {
      ...common,
      status,
      joined: testAuditStamp(1),
      left: null,
      removed: null,
      banned: testAuditStamp(1),
    };
  }
  return {
    ...snapshot,
    members: [member],
    memberCount: status === 'active' ? 1 : 0,
    onlineMemberCount: 0,
  };
}

function createDeletedGroupSnapshot(
  groupId: string,
  principalId: string,
): GroupSnapshot {
  const snapshot = createGroupSnapshot(groupId, [principalId]);
  return {
    ...snapshot,
    group: {
      ...snapshot.group,
      status: 'deleted',
      archived: null,
      deleted: testAuditStamp(2),
    },
  };
}

function createClientEvent(eventId: string): ClientEvent {
  return {
    ...TEST_SCOPE,
    principalId: 'alice',
    eventId,
    eventType: 'principal-updated',
    snapshotVersion: 1,
    occurredAtEpochMs: 1,
    clientInstanceId: null,
    sessionId: null,
    actor: { kind: 'service', serviceId: 'test' },
    reason: null,
    traceId: null,
    requestId: null,
    payload: {},
  };
}

function createGroupEvent(eventId: string): GroupEvent {
  return {
    ...TEST_SCOPE,
    groupId: 'room-1',
    eventId,
    eventType: 'group-updated',
    snapshotVersion: 1,
    causalRevision: { groupRevision: 1, presenceRevision: 0 },
    occurredAtEpochMs: 1,
    actor: { kind: 'service', serviceId: 'test' },
    reason: null,
    traceId: null,
    requestId: null,
    payload: {},
  };
}

function testAuditStamp(atEpochMs: number): AuditStamp {
  return {
    atEpochMs,
    actor: { kind: 'service', serviceId: 'test' },
    reason: null,
    traceId: null,
    requestId: null,
  };
}
