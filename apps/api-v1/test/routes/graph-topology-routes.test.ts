import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import { Either } from '@shared/resilience/Either.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { GraphDiagnosticReadResponse } from '@shared/api/graph-topology-management-types.ts';
import * as graphTopologyRoutes from '../../src/routes/graph-topology-routes.ts';

const TEST_SCOPE: StateScope = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
};

Deno.test('scoped graph routes pass scope and group refs to diagnostics', async () => {
  const calls: unknown[] = [];
  const group = createGroupSnapshot('room-1', ['owner']);
  const app = createRouteApp({
    group,
    graphDiagnostics: {
      readScopedGlobalGraphDiagnostic: (scope, options) => {
        calls.push({ kind: 'global', scope, options });
        return Either.ofRight(createGraphResponse({
          ...scope,
          groupId: '__global__',
        }));
      },
      readGroupGraphDiagnostic: (groupRef, options) => {
        calls.push({ kind: 'group', groupRef, options });
        return Either.ofRight(createGraphResponse(groupRef));
      },
    },
  });

  const globalResponse = await app.request(
    '/api/state/apps/app-1/workspaces/workspace-1/graphs/global?includeMeasured=true&refresh=always',
  );
  const groupResponse = await app.request(
    '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/graphs/latest',
  );

  assert.equal(globalResponse.status, 200);
  assert.equal(groupResponse.status, 200);
  assert.deepEqual((await globalResponse.json()).groupRef, {
    ...TEST_SCOPE,
    groupId: '__global__',
  });
  assert.deepEqual((await groupResponse.json()).groupRef, {
    ...TEST_SCOPE,
    groupId: 'room-1',
  });
  assert.deepEqual(calls, [
    {
      kind: 'global',
      scope: TEST_SCOPE,
      options: { includeMeasured: true, refresh: 'always' },
    },
    {
      kind: 'group',
      groupRef: { ...TEST_SCOPE, groupId: 'room-1' },
      options: { includeMeasured: false, refresh: 'if-missing' },
    },
  ]);
});

Deno.test('strict read auth allows active members and rejects non-members', async () => {
  await withStrictReadAuth(true, async () => {
    const app = createRouteApp({
      group: createGroupSnapshot('room-1', ['owner']),
      session: { clientId: 'intruder', sessionId: 'intruder-session' },
    });

    const denied = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/topology',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'group-policy-denied');
  });

  await withStrictReadAuth(true, async () => {
    const app = createRouteApp({
      group: createGroupSnapshot('room-1', ['owner']),
      session: { clientId: 'owner', sessionId: 'owner-session' },
    });

    const allowed = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/topology',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(allowed.status, 200);
  });
});

Deno.test('strict read auth rejects unauthenticated scoped global graph diagnostics', async () => {
  await withStrictReadAuth(true, async () => {
    let authCalls = 0;
    const app = createRouteApp({
      requireApiAuthSession: () => {
        authCalls += 1;
        throw new Error('Unauthorized: missing auth session');
      },
    });

    const denied = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/graphs/global',
    );

    assert.equal(denied.status, 401);
    assert.equal(authCalls, 1);
  });
});

Deno.test('topology writes require group manager or platform admin auth', async () => {
  const memberApp = createRouteApp({
    group: createGroupSnapshot('room-1', ['owner', 'member']),
    session: { clientId: 'member', sessionId: 'member-session' },
  });
  const memberDenied = await memberApp.request(
    '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/topology/config',
    {
      method: 'PUT',
      headers: { authorization: 'Bearer token' },
      body: JSON.stringify({ config: { topologyKind: 'tree' } }),
    },
  );
  assert.equal(memberDenied.status, 403);

  const ownerCalls: unknown[] = [];
  const ownerApp = createRouteApp({
    group: createGroupSnapshot('room-1', ['owner']),
    session: { clientId: 'owner', sessionId: 'owner-session' },
    topologyManagement: {
      putConfig: (input) => {
        ownerCalls.push(input);
        return Promise.resolve({ ok: true });
      },
    },
  });
  const ownerAllowed = await ownerApp.request(
    '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/topology/config',
    {
      method: 'PUT',
      headers: {
        authorization: 'Bearer token',
        'Idempotency-Key': 'idem-1',
      },
      body: JSON.stringify({ config: { topologyKind: 'tree' } }),
    },
  );
  assert.equal(ownerAllowed.status, 200);
  assert.deepEqual(ownerCalls[0], {
    groupRef: { ...TEST_SCOPE, groupId: 'room-1' },
    config: { topologyKind: 'tree' },
    updatedByPrincipalId: 'owner',
    requestId: 'idem-1',
    reconfigure: true,
    publish: true,
  });

  const adminCalls: unknown[] = [];
  const adminApp = createRouteApp({
    group: createGroupSnapshot('room-1', ['owner']),
    session: { clientId: 'platform-admin', sessionId: 'admin-session' },
    adminClientIds: ['platform-admin'],
    topologyManagement: {
      putConfig: (input) => {
        adminCalls.push(input);
        return Promise.resolve({ ok: true });
      },
    },
  });
  const adminAllowed = await adminApp.request(
    '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/topology/config',
    {
      method: 'PUT',
      headers: { authorization: 'Bearer token' },
      body: JSON.stringify({ config: { topologyKind: 'mesh' } }),
    },
  );
  assert.equal(adminAllowed.status, 200);
  assert.equal((adminCalls[0] as { updatedByPrincipalId: string }).updatedByPrincipalId, 'platform-admin');
});

Deno.test('topology override, delete, and reconfigure routes forward request options', async () => {
  const calls: unknown[] = [];
  const app = createRouteApp({
    group: createGroupSnapshot('room-1', ['owner']),
    session: { clientId: 'owner', sessionId: 'owner-session' },
    topologyManagement: {
      putOverride: (input) => {
        calls.push({ kind: 'putOverride', input });
        return Promise.resolve({ ok: true });
      },
      deleteConfig: (input) => {
        calls.push({ kind: 'deleteConfig', input });
        return Promise.resolve({ ok: true });
      },
      deleteOverride: (input) => {
        calls.push({ kind: 'deleteOverride', input });
        return Promise.resolve({ ok: true });
      },
      reconfigureGroupTopology: (input) => {
        calls.push({ kind: 'reconfigure', input });
        return Promise.resolve({
          changed: true,
          published: true,
          snapshot: { version: 1 },
          config: { effective: { topologyKind: 'tree' } },
        });
      },
    },
  });

  assert.equal((await app.request(
    '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/topology/override',
    {
      method: 'PUT',
      headers: {
        authorization: 'Bearer token',
        'Idempotency-Key': 'override-idem',
      },
      body: JSON.stringify({ config: { degreeLimit: 4 }, ttlMs: 5_000 }),
    },
  )).status, 200);
  assert.equal((await app.request(
    '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/topology/config?reconfigure=false',
    {
      method: 'DELETE',
      headers: { authorization: 'Bearer token' },
    },
  )).status, 200);
  assert.equal((await app.request(
    '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/topology/override',
    {
      method: 'DELETE',
      headers: { authorization: 'Bearer token' },
    },
  )).status, 200);
  const reconfigureResponse = await app.request(
    '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/topology/reconfigure',
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'Idempotency-Key': 'reconfigure-idem',
      },
      body: JSON.stringify({ options: { topologyKind: 'tree' }, publish: false }),
    },
  );

  assert.equal(reconfigureResponse.status, 200);
  assert.deepEqual(calls, [
    {
      kind: 'putOverride',
      input: {
        groupRef: { ...TEST_SCOPE, groupId: 'room-1' },
        config: { degreeLimit: 4 },
        ttlMs: 5_000,
        expiresAtEpochMs: undefined,
        updatedByPrincipalId: 'owner',
        requestId: 'override-idem',
        reconfigure: true,
        publish: true,
      },
    },
    {
      kind: 'deleteConfig',
      input: {
        groupRef: { ...TEST_SCOPE, groupId: 'room-1' },
        updatedByPrincipalId: 'owner',
        requestId: undefined,
        reconfigure: false,
        publish: true,
      },
    },
    {
      kind: 'deleteOverride',
      input: {
        groupRef: { ...TEST_SCOPE, groupId: 'room-1' },
        updatedByPrincipalId: 'owner',
        requestId: undefined,
        reconfigure: true,
        publish: true,
      },
    },
    {
      kind: 'reconfigure',
      input: {
        groupRef: { ...TEST_SCOPE, groupId: 'room-1' },
        requestOptions: { topologyKind: 'tree' },
        publish: false,
        requestId: 'reconfigure-idem',
      },
    },
  ]);
});

Deno.test('topology reconfigure accepts an empty request body', async () => {
  const calls: unknown[] = [];
  const app = createRouteApp({
    group: createGroupSnapshot('room-1', ['owner']),
    session: { clientId: 'owner', sessionId: 'owner-session' },
    topologyManagement: {
      reconfigureGroupTopology: (input) => {
        calls.push(input);
        return Promise.resolve({
          changed: false,
          published: false,
          snapshot: { version: 1 },
          config: { effective: { topologyKind: 'auto' } },
        });
      },
    },
  });

  const response = await app.request(
    '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/topology/reconfigure',
    {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    {
      groupRef: { ...TEST_SCOPE, groupId: 'room-1' },
      requestOptions: undefined,
      publish: true,
      requestId: undefined,
    },
  ]);
});

Deno.test('graph topology routes map missing groups and validation errors', async () => {
  const missingApp = createRouteApp({ group: undefined });
  const missing = await missingApp.request(
    '/api/state/apps/app-1/workspaces/workspace-1/groups/missing/topology',
  );
  assert.equal(missing.status, 404);

  const invalidApp = createRouteApp({
    group: createGroupSnapshot('room-1', ['owner']),
    session: { clientId: 'owner', sessionId: 'owner-session' },
    topologyManagement: {
      putConfig: () => {
        const error = new Error('invalid config') as Error & { status: number; issues: unknown[] };
        error.status = 422;
        error.issues = [{ code: 'invalid-positive-integer' }];
        throw error;
      },
    },
  });
  const invalid = await invalidApp.request(
    '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/topology/config',
    {
      method: 'PUT',
      headers: { authorization: 'Bearer token' },
      body: JSON.stringify({ config: { degreeLimit: 0 } }),
    },
  );

  assert.equal(invalid.status, 422);
  assert.deepEqual((await invalid.json()).issues, [{ code: 'invalid-positive-integer' }]);
});

function createRouteApp(options: {
  readonly group?: GroupSnapshot;
  readonly session?: { clientId: string; sessionId: string };
  readonly adminClientIds?: readonly string[];
  readonly requireApiAuthSession?: GraphTopologyRouteRequireApiAuthSession;
  readonly graphDiagnostics?: Partial<graphTopologyRoutes.GraphTopologyRouteDependencies['graphDiagnostics']>;
  readonly topologyManagement?: Partial<graphTopologyRoutes.GraphTopologyRouteDependencies['topologyManagement']>;
}): Hono {
  const app = new Hono();
  graphTopologyRoutes.init(app, {
    getGroupStateService: () => ({
      readSnapshot: (ref: GroupRef) =>
        Promise.resolve(
          options.group &&
              options.group.group.applicationId === ref.applicationId &&
              options.group.group.workspaceId === ref.workspaceId &&
              options.group.group.groupId === ref.groupId
            ? options.group
            : undefined,
        ),
    }),
    requireApiAuthSession: options.requireApiAuthSession ??
      (() => Promise.resolve(options.session ?? { clientId: 'owner', sessionId: 'owner-session' })),
    adminClientIds: options.adminClientIds ?? [],
    graphDiagnostics: {
      readScopedGlobalGraphDiagnostic: options.graphDiagnostics?.readScopedGlobalGraphDiagnostic ??
        ((scope) => Either.ofRight(createGraphResponse({ ...scope, groupId: '__global__' }))),
      readGroupGraphDiagnostic: options.graphDiagnostics?.readGroupGraphDiagnostic ??
        ((groupRef) => Either.ofRight(createGraphResponse(groupRef))),
    },
    topologyManagement: {
      readTopologyView: options.topologyManagement?.readTopologyView ??
        ((groupRef) => Promise.resolve({ groupRef, overlayId: 'overlay', config: {} })),
      readConfig: options.topologyManagement?.readConfig ??
        (() => Promise.resolve({ effective: { topologyKind: 'auto' } })),
      putConfig: options.topologyManagement?.putConfig ??
        (() => Promise.resolve({ ok: true })),
      deleteConfig: options.topologyManagement?.deleteConfig ??
        (() => Promise.resolve({ ok: true })),
      readOverride: options.topologyManagement?.readOverride ??
        (() => Promise.resolve(undefined)),
      putOverride: options.topologyManagement?.putOverride ??
        (() => Promise.resolve({ ok: true })),
      deleteOverride: options.topologyManagement?.deleteOverride ??
        (() => Promise.resolve({ ok: true })),
      reconfigureGroupTopology: options.topologyManagement?.reconfigureGroupTopology ??
        (() => Promise.resolve({ changed: false, published: false })),
    },
  });
  return app;
}

type GraphTopologyRouteRequireApiAuthSession =
  graphTopologyRoutes.GraphTopologyRouteDependencies['requireApiAuthSession'];

function createGraphResponse(groupRef: GroupRef): GraphDiagnosticReadResponse {
  return {
    groupRef,
    snapshot: {
      groupRef,
      predicted: {
        groupRef,
        graph: { nodes: [], edges: [] },
        groupGraph: { nodes: [], edges: [] },
        coreNodes: [],
      },
      createdAtEpochMs: 1,
      version: 1,
    },
    cache: {
      hit: false,
      refreshed: true,
    },
  };
}

function createGroupSnapshot(
  groupId: string,
  memberPrincipalIds: readonly string[],
): GroupSnapshot {
  return {
    stateRevision: 1,
    group: {
      ...TEST_SCOPE,
      groupId,
      displayName: groupId,
      kind: 'room',
      status: 'active',
      joinMode: 'open',
      metadata: {},
      snapshotVersion: 1,
      metadataVersion: 0,
      rosterVersion: 1,
      presenceVersion: 0,
      created: { atEpochMs: 1, byPrincipalId: 'owner' },
      updated: { atEpochMs: 1, byPrincipalId: 'owner' },
    },
    members: memberPrincipalIds.map((principalId, index) => ({
      ...TEST_SCOPE,
      groupId,
      principalId,
      role: index === 0 ? 'owner' : 'member',
      status: 'active',
      joined: { atEpochMs: 1, byPrincipalId: 'owner' },
      updated: { atEpochMs: 1, byPrincipalId: 'owner' },
    })),
    activeSessions: memberPrincipalIds.map((principalId) => ({
      ...TEST_SCOPE,
      groupId,
      principalId,
      sessionId: `${principalId}-session`,
      connectedAtEpochMs: 1,
      lastHeartbeatAtEpochMs: 1,
      expiresAtEpochMs: 60_000,
    })),
    memberCount: memberPrincipalIds.length,
    onlineMemberCount: memberPrincipalIds.length,
  };
}

async function withStrictReadAuth(
  enabled: boolean,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = Deno.env.get('RALLAR_STATE_STRICT_READ_AUTH');
  try {
    if (enabled) {
      Deno.env.set('RALLAR_STATE_STRICT_READ_AUTH', 'true');
    } else {
      Deno.env.delete('RALLAR_STATE_STRICT_READ_AUTH');
    }
    await fn();
  } finally {
    if (previous === undefined) {
      Deno.env.delete('RALLAR_STATE_STRICT_READ_AUTH');
    } else {
      Deno.env.set('RALLAR_STATE_STRICT_READ_AUTH', previous);
    }
  }
}
