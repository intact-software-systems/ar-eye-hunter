import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import { Either } from '@shared/resilience/Either.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { GraphDiagnosticReadResponse } from '@shared/api/graph-topology-management-types.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
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
      session: createIssuedSession('intruder', 'intruder-session'),
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
      session: createIssuedSession('owner', 'owner-session'),
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
    session: createIssuedSession('member', 'member-session'),
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
    session: createIssuedSession('owner', 'owner-session'),
    processTopologyAppInbox: (_authority, enqueue) => {
      ownerCalls.push(enqueue);
        return Promise.resolve({ ok: true });
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
  assert.deepEqual((ownerCalls[0] as { data: { payload: unknown } }).data.payload, {
    operation: 'putConfig',
    config: toCanonicalGroupTopologyConfigPatch({ topologyKind: 'tree' }),
  });

  const adminCalls: unknown[] = [];
  const adminApp = createRouteApp({
    group: createGroupSnapshot('room-1', ['owner']),
    session: createIssuedSession('platform-admin', 'admin-session'),
    adminClientIds: ['platform-admin'],
    processTopologyAppInbox: (_authority, enqueue) => {
      adminCalls.push(enqueue);
        return Promise.resolve({ ok: true });
      },
  });
  const adminAllowed = await adminApp.request(
    '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/topology/config',
    {
      method: 'PUT',
      headers: {
        authorization: 'Bearer token',
        'Idempotency-Key': 'admin-idem',
      },
      body: JSON.stringify({ config: { topologyKind: 'mesh' } }),
    },
  );
  assert.equal(adminAllowed.status, 200);
  assert.equal(
    (adminCalls[0] as { data: { actor: { principalId: string } } }).data.actor.principalId,
    'platform-admin',
  );
});

Deno.test('all topology mutation routes submit complete AppInbox commands and never call direct writers', async () => {
  const appInboxCommands: unknown[] = [];
  const directTopologyMutationCalls: string[] = [];
  const app = createRouteApp({
    group: createGroupSnapshot('room-1', ['owner']),
    session: createIssuedSession('owner', 'owner-session'),
    processTopologyAppInbox: (authority, enqueue) => {
      appInboxCommands.push({ authority, enqueue });
      return Promise.resolve({ operation: enqueue.type, committed: true });
    },
    topologyManagement: {
      putConfig: () => recordDirectMutation(directTopologyMutationCalls, 'putConfig'),
      deleteConfig: () => recordDirectMutation(directTopologyMutationCalls, 'deleteConfig'),
      putOverride: () => recordDirectMutation(directTopologyMutationCalls, 'putOverride'),
      deleteOverride: () => recordDirectMutation(directTopologyMutationCalls, 'deleteOverride'),
      reconfigureGroupTopology: () =>
        recordDirectMutation(directTopologyMutationCalls, 'reconfigureGroupTopology'),
      },
  });

  const mutations: readonly Readonly<{
    method: 'PUT' | 'DELETE' | 'POST';
    path: 'config' | 'override' | 'reconfigure';
    requestId: string;
    body?: unknown;
  }>[] = [
    {
      method: 'PUT',
      path: 'config',
      requestId: 'config-put',
      body: { config: { topologyKind: 'tree' } },
      },
    { method: 'DELETE', path: 'config', requestId: 'config-delete' },
    {
      method: 'PUT',
      path: 'override',
      requestId: 'override-put',
      body: { config: { degreeLimit: 4 }, ttlMs: 5_000 },
      },
    { method: 'DELETE', path: 'override', requestId: 'override-delete' },
    {
      method: 'POST',
      path: 'reconfigure',
      requestId: 'reconfigure',
      body: { options: { topologyKind: 'mesh' }, publish: false },
    },
  ];

  for (const mutation of mutations) {
    const response = await app.request(
      `/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/topology/${mutation.path}`,
      {
        method: mutation.method,
        headers: {
          authorization: 'Bearer token',
          'Idempotency-Key': mutation.requestId,
      },
        ...(mutation.body === undefined ? {} : { body: JSON.stringify(mutation.body) }),
      },
    );
    assert.equal(response.status, 200);
  }

  assert.deepEqual(
    appInboxCommands.map((value) => (value as { enqueue: { type: string } }).enqueue.type),
    [
      'TOPOLOGY_CONFIG_PUT',
      'TOPOLOGY_CONFIG_DELETE',
      'TOPOLOGY_OVERRIDE_PUT',
      'TOPOLOGY_OVERRIDE_DELETE',
      'TOPOLOGY_RECONFIGURE',
    ],
  );
  assert.deepEqual(directTopologyMutationCalls, []);
  for (const value of appInboxCommands) {
    const command = value as {
      authority: ReturnType<typeof createIssuedSession>;
      enqueue: {
        resourceId: string;
        contextId: string;
        senderId: string;
        data: {
          actor: { principalId: string; sessionId: string };
          groupRef: GroupRef;
          requestId: string;
          commandHash: string;
          capturedAtEpochMs: number;
          operation: string;
          payload: Record<string, unknown>;
        };
      };
    };
    assert.equal(command.authority.accessToken, 'owner-token');
    assert.equal(command.enqueue.resourceId, command.enqueue.data.requestId);
    assert.equal(command.enqueue.contextId, 'app-1:workspace-1:room-1');
    assert.equal(command.enqueue.senderId, 'owner');
    assert.deepEqual(command.enqueue.data.actor, {
      principalId: 'owner',
      sessionId: 'owner-session',
    });
    assert.deepEqual(command.enqueue.data.groupRef, {
      ...TEST_SCOPE,
      groupId: 'room-1',
    });
    assert.match(command.enqueue.data.commandHash, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(command.enqueue.data.capturedAtEpochMs, 123_456);
    assert.equal(typeof command.enqueue.data.operation, 'string');
    assert.equal(typeof command.enqueue.data.payload, 'object');
  }
});

Deno.test('topology AppInbox context ids preserve scoped component boundaries', async () => {
  const contexts: string[] = [];
  const refs = [
    { applicationId: 'app:a', workspaceId: 'workspace', groupId: 'room' },
    { applicationId: 'app', workspaceId: 'a:workspace', groupId: 'room' },
  ] as const;

  for (const ref of refs) {
    const app = createRouteApp({
      group: createGroupSnapshot(ref.groupId, ['owner'], ref),
      session: createIssuedSession('owner', 'owner-session'),
      processTopologyAppInbox: (_authority, enqueue) => {
        contexts.push(enqueue.contextId);
        return Promise.resolve({ status: 'queued' });
      },
    });
    const response = await app.request(
      `/api/state/apps/${encodeURIComponent(ref.applicationId)}/workspaces/${
        encodeURIComponent(ref.workspaceId)
      }/groups/${encodeURIComponent(ref.groupId)}/topology/config`,
      {
        method: 'PUT',
        headers: {
          authorization: 'Bearer token',
          'Idempotency-Key': `context-${contexts.length}`,
        },
        body: JSON.stringify({ config: { topologyKind: 'tree' } }),
      },
    );
    assert.equal(response.status, 200);
  }

  assert.deepEqual(contexts, [
    'app%3Aa:workspace:room',
    'app:a%3Aworkspace:room',
  ]);
  assert.notEqual(contexts[0], contexts[1]);
});

Deno.test('topology mutations return after commit while explicit reconfigure forwards options', async () => {
  const calls: unknown[] = [];
  const app = createRouteApp({
    group: createGroupSnapshot('room-1', ['owner']),
    session: createIssuedSession('owner', 'owner-session'),
    processTopologyAppInbox: (_authority, enqueue) => {
      calls.push(enqueue);
      return Promise.resolve({ committed: true });
    },
  });

  assert.equal(
    (await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/topology/override',
      {
        method: 'PUT',
        headers: {
          authorization: 'Bearer token',
          'Idempotency-Key': 'override-idem',
        },
        body: JSON.stringify({ config: { degreeLimit: 4 }, ttlMs: 5_000 }),
      },
    )).status,
    200,
  );
  assert.equal(
    (await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/topology/config',
      {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer token',
          'Idempotency-Key': 'config-delete-idem',
        },
      },
    )).status,
    200,
  );
  assert.equal(
    (await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/topology/override',
      {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer token',
          'Idempotency-Key': 'override-delete-idem',
        },
      },
    )).status,
    200,
  );
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
  assert.deepEqual(
    calls.map((call) => (call as { data: { payload: unknown } }).data.payload),
    [
    {
        operation: 'putOverride',
        config: toCanonicalGroupTopologyConfigPatch({ degreeLimit: 4 }),
        ttlMs: 5_000,
        expiresAtEpochMs: null,
    },
      { operation: 'deleteConfig', target: 'config' },
      { operation: 'deleteOverride', target: 'override' },
    {
        operation: 'reconfigureTopology',
        requestOptions: toCanonicalGroupTopologyConfigPatch({ topologyKind: 'tree' }),
        publish: false,
    },
    ],
  );
});

Deno.test('topology reconfigure requires a request id with an empty request body', async () => {
  const calls: unknown[] = [];
  const app = createRouteApp({
    group: createGroupSnapshot('room-1', ['owner']),
    session: createIssuedSession('owner', 'owner-session'),
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

  assert.equal(response.status, 400);
  assert.deepEqual(calls, []);
});

Deno.test('graph topology routes map missing groups and validation errors', async () => {
  const missingApp = createRouteApp({ group: undefined });
  const missing = await missingApp.request(
    '/api/state/apps/app-1/workspaces/workspace-1/groups/missing/topology',
  );
  assert.equal(missing.status, 404);

  const invalidApp = createRouteApp({
    group: createGroupSnapshot('room-1', ['owner']),
    session: createIssuedSession('owner', 'owner-session'),
    processTopologyAppInbox: () => {
        const error = new Error('invalid config') as Error & { status: number; issues: unknown[] };
        error.status = 422;
        error.issues = [{ code: 'invalid-positive-integer' }];
        throw error;
      },
  });
  const invalid = await invalidApp.request(
    '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/topology/config',
    {
      method: 'PUT',
      headers: {
        authorization: 'Bearer token',
        'Idempotency-Key': 'invalid-config-idem',
      },
      body: JSON.stringify({ config: { degreeLimit: 0 } }),
    },
  );

  assert.equal(invalid.status, 422);
  assert.deepEqual((await invalid.json()).issues, [{ code: 'invalid-positive-integer' }]);
});

function createRouteApp(options: {
  readonly group?: GroupSnapshot;
  readonly session?: ReturnType<typeof createIssuedSession>;
  readonly adminClientIds?: readonly string[];
  readonly requireApiAuthSession?: GraphTopologyRouteRequireApiAuthSession;
  readonly graphDiagnostics?: Partial<
    graphTopologyRoutes.GraphTopologyRouteDependencies['graphDiagnostics']
  >;
  readonly topologyManagement?: Partial<
    graphTopologyRoutes.GraphTopologyRouteDependencies['topologyManagement']
  >;
  readonly processTopologyAppInbox?: (
    authority: ReturnType<typeof createIssuedSession>,
    enqueue: {
      type: string;
      resourceId: string;
      contextId: string;
      senderId: string;
      data: unknown;
    },
  ) => Promise<unknown>;
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
      (() => Promise.resolve(options.session ?? createIssuedSession('owner', 'owner-session'))),
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
    processTopologyAppInbox: options.processTopologyAppInbox,
    now: () => 123_456,
  } as unknown as Partial<graphTopologyRoutes.GraphTopologyRouteDependencies>);
  return app;
}

function createIssuedSession(clientId: string, sessionId: string) {
  return {
    clientId,
    sessionId,
    accessToken: `${clientId}-token`,
    username: clientId,
    issuedAtEpochMs: 100,
    expiresAtEpochMs: 1_000_000,
  };
}

function recordDirectMutation(calls: string[], operation: string): Promise<unknown> {
  calls.push(operation);
  return Promise.resolve({ operation, committed: true });
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
  scope: StateScope = TEST_SCOPE,
): GroupSnapshot {
  return {
    stateRevision: 1,
    causalRevision: { groupRevision: 1, presenceRevision: 0 },
    group: {
      ...scope,
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
      snapshotVersion: 1,
      metadataVersion: 0,
      rosterVersion: 1,
      presenceVersion: 0,
      activeMemberCount: memberPrincipalIds.length,
      ownerPrincipalId: 'owner',
      created: createPrincipalAuditStamp(1, 'owner'),
      updated: createPrincipalAuditStamp(1, 'owner'),
      expiresAtEpochMs: null,
      emptySinceEpochMs: null,
      purgeAfterEpochMs: null,
      archived: null,
      deleted: null,
    },
    members: memberPrincipalIds.map((principalId, index) => ({
      ...scope,
      groupId,
      principalId,
      role: index === 0 ? 'owner' : 'member',
      status: 'active',
      joined: createPrincipalAuditStamp(1, 'owner'),
      updated: createPrincipalAuditStamp(1, 'owner'),
      invitedByPrincipalId: null,
      invitationExpiresAtEpochMs: null,
      left: null,
      removed: null,
      banned: null,
    })),
    activeSessions: memberPrincipalIds.map((principalId) => ({
      ...scope,
      groupId,
      principalId,
      sessionId: `${principalId}-session`,
      generationId: `${principalId}-generation`,
      generationVersion: 1,
      connectedAtEpochMs: 1,
      lastHeartbeatAtEpochMs: 1,
      expiresAtEpochMs: 60_000,
      status: 'active',
      disconnectedAtEpochMs: null,
      disconnectReason: null,
    })),
    memberCount: memberPrincipalIds.length,
    onlineMemberCount: memberPrincipalIds.length,
  };
}

function createPrincipalAuditStamp(atEpochMs: number, principalId: string) {
  return {
    atEpochMs,
    actor: { kind: 'principal' as const, principalId },
    reason: null,
    traceId: null,
    requestId: null,
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
