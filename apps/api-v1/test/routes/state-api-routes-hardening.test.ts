import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
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
    assert.deepEqual(await denied.json(), {
      error: 'Forbidden: only active group members can read group state',
    });
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
    session: AuthSession;
    clientService: Partial<clientStateRoutes.ClientStateRouteService>;
    hydrateStateSyncSnapshotCaches?: clientStateRoutes.ClientStateRouteDependencies[
      'hydrateStateSyncSnapshotCaches'
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
    hydrateStateSyncSnapshotCaches: input.hydrateStateSyncSnapshotCaches ??
      (() => Promise.resolve({ clientSnapshotCount: 0, groupSnapshotCount: 0 })),
    authCallCount: () => authCalls,
  };
}

function createGroupRouteDeps(
  input: Readonly<{
    session: AuthSession;
    groupService: Partial<groupStateRoutes.GroupStateRouteService>;
    hydrateStateSyncSnapshotCaches?: groupStateRoutes.GroupStateRouteDependencies[
      'hydrateStateSyncSnapshotCaches'
    ];
  }>,
): Required<groupStateRoutes.GroupStateRouteDependencies> {
  return {
    getGroupStateService: () => ({
      listSnapshots: () => Promise.resolve([]),
      readSnapshot: () => Promise.resolve(undefined),
      listEvents: () => Promise.resolve([]),
      listEventPage: () => Promise.resolve({ events: [], hasMore: false }),
      ...input.groupService,
    } as groupStateRoutes.GroupStateRouteService),
    requireApiAuthSession: () => Promise.resolve(input.session),
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

function createAuthSession(clientId: string): AuthSession {
  return {
    clientId,
    accessToken: 'token',
    username: clientId,
    sessionId: `${clientId}-session`,
    expiresAtEpochMs: Date.now() + 60_000,
  };
}

function createClientSnapshot(principalId: string): ClientSnapshot {
  return {
    principal: {
      ...TEST_SCOPE,
      principalId,
      username: principalId,
      displayName: principalId,
      status: 'active',
      roles: [],
      metadata: {},
      snapshotVersion: 1,
      profileVersion: 1,
      presenceVersion: 0,
      created: { atEpochMs: 1, byServiceId: 'test' },
      updated: { atEpochMs: 1, byServiceId: 'test' },
    },
    instances: [],
    activeSessions: [],
    isOnline: false,
    activeSessionCount: 0,
  };
}

function createGroupSnapshot(
  groupId: string,
  activePrincipalIds: readonly string[],
): GroupSnapshot {
  return {
    group: {
      ...TEST_SCOPE,
      groupId,
      displayName: groupId,
      kind: 'room',
      status: 'active',
      joinMode: 'open',
      metadata: {},
      snapshotVersion: 1,
      metadataVersion: 1,
      rosterVersion: 1,
      presenceVersion: 0,
      created: { atEpochMs: 1, byServiceId: 'test' },
      updated: { atEpochMs: 1, byServiceId: 'test' },
    },
    members: activePrincipalIds.map((principalId) => ({
      ...TEST_SCOPE,
      groupId,
      principalId,
      role: 'member' as const,
      status: 'active' as const,
      joined: { atEpochMs: 1, byServiceId: 'test' },
      updated: { atEpochMs: 1, byServiceId: 'test' },
    })),
    activeSessions: [],
    memberCount: activePrincipalIds.length,
    onlineMemberCount: 0,
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
    actor: { serviceId: 'test' },
  };
}

function createGroupEvent(eventId: string): GroupEvent {
  return {
    ...TEST_SCOPE,
    groupId: 'room-1',
    eventId,
    eventType: 'group-updated',
    snapshotVersion: 1,
    occurredAtEpochMs: 1,
    actor: { serviceId: 'test' },
  };
}
