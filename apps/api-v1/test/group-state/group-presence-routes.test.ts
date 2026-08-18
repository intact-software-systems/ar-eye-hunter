import assert from 'node:assert/strict';

import type {
  AppInboxEnqueueInput,
} from '@shared-server/rallar-system/services/AppInboxService.ts';

import { toGroupStateCommand } from '../../src/group-state/to-group-state-command.ts';
import { toGroupStateResponse } from '../../src/group-state/to-group-state-response.ts';
import type {
  GroupStateRouteAuthSession,
  ProcessGroupAppInbox,
} from '../../src/group-state/group-state-route-contracts.ts';

import {
  createGroupStateRouteAuthSession,
  createGroupStateRouteSnapshot,
  createGroupStateRouteTestRuntime,
  createPredecessorGroupStateRouteAuthSession,
  createPredecessorGroupStateRouteSnapshot,
  createPredecessorGroupStateRouteTestRuntime,
  TEST_GROUP_SCOPE,
} from './group-state-route-test-runtime.ts';

const API_BASE =
  '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/sessions/alice-session';
const AUTHENTICATED_HEADERS = {
  authorization: 'Bearer token',
  'content-type': 'application/json',
} as const;
const PRESENCE_CONNECT_ROUTE = { path: API_BASE, method: 'PUT' } as const;
const PRESENCE_HEARTBEAT_ROUTE = { path: `${API_BASE}/heartbeat`, method: 'POST' } as const;
const PRESENCE_DISCONNECT_ROUTE = { path: `${API_BASE}/disconnect`, method: 'POST' } as const;

Deno.test('group presence commands retain validation and authenticated envelopes', () => {
  const authSession = createGroupStateRouteAuthSession('alice');
  const commandBase = {
    authSession,
    scope: TEST_GROUP_SCOPE,
    groupId: 'room-1',
    sessionId: 'alice-session',
  } as const;
  const forgedActor = {
    principalId: 'forged-principal',
    actorPrincipalId: 'forged-actor',
    actorSessionId: 'forged-session',
  };
  const commands = [
    toGroupStateCommand({
      operation: 'connect-group-presence',
      ...commandBase,
      request: {
        generationId: 'generation-connect',
        ...forgedActor,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 2,
        requestId: 'connect-request',
      },
    }),
    toGroupStateCommand({
      operation: 'heartbeat-group-presence',
      ...commandBase,
      request: {
        generationId: 'generation-heartbeat',
        ...forgedActor,
        lastHeartbeatAtEpochMs: 2,
        expiresAtEpochMs: 3,
        requestId: 'heartbeat-request',
      },
    }),
    toGroupStateCommand({
      operation: 'disconnect-group-presence',
      ...commandBase,
      request: {
        generationId: 'generation-disconnect',
        ...forgedActor,
        lastHeartbeatAtEpochMs: 3,
        disconnectedAtEpochMs: 4,
        expiresAtEpochMs: 5,
        requestId: 'disconnect-request',
      },
    }),
  ];

  assert.equal(
    JSON.stringify(commands),
    '[{"type":"GROUP_PRESENCE_CONNECT","resourceId":"connect-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","sessionId":"alice-session","request":{"generationId":"generation-connect","principalId":"alice","actorPrincipalId":"alice","actorSessionId":"alice-session","connectedAtEpochMs":1,"lastHeartbeatAtEpochMs":1,"expiresAtEpochMs":2,"requestId":"connect-request"}}},{"type":"GROUP_PRESENCE_HEARTBEAT","resourceId":"heartbeat-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","sessionId":"alice-session","request":{"generationId":"generation-heartbeat","principalId":"alice","actorPrincipalId":"alice","actorSessionId":"alice-session","lastHeartbeatAtEpochMs":2,"expiresAtEpochMs":3,"requestId":"heartbeat-request"}}},{"type":"GROUP_PRESENCE_DISCONNECT","resourceId":"disconnect-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","sessionId":"alice-session","request":{"generationId":"generation-disconnect","principalId":"alice","actorPrincipalId":"alice","actorSessionId":"alice-session","lastHeartbeatAtEpochMs":3,"disconnectedAtEpochMs":4,"expiresAtEpochMs":5,"requestId":"disconnect-request"}}}]',
  );
});

Deno.test('group presence response retains the current snapshot and JSON order', async () => {
  const snapshot = createGroupStateRouteSnapshot('room-1');
  let currentSnapshotReads = 0;
  const service = createPresenceResponseService(snapshot, () => {
    currentSnapshotReads += 1;
  });
  const ref = { ...TEST_GROUP_SCOPE, groupId: 'room-1' };
  const accepted = await toGroupStateResponse({
    kind: 'presence',
    receipt: {
      commandId: 'presence-command',
      requestId: 'presence-request',
      commandHash: 'presence-hash',
      aggregateRef: ref,
      outcome: 'applied',
      attemptCount: 1,
      acceptedStorageRevision: 1,
      stateRevision: 1,
      snapshotVersion: 1,
      causalRevision: { groupRevision: 1, presenceRevision: 1 },
      eventId: null,
      outboxIds: [],
      joinCode: null,
      joinCodeExpiresAtEpochMs: null,
      rejection: null,
    },
    ref,
    service,
  });

  assert.strictEqual(accepted, snapshot);
  assert.equal(
    JSON.stringify(accepted),
    '{"stateRevision":1,"causalRevision":{"groupRevision":1,"presenceRevision":0},"group":{"applicationId":"app-1","workspaceId":"workspace-1","groupId":"room-1","slug":null,"displayName":"room-1","description":null,"kind":"room","status":"active","joinMode":"open","maxMembers":null,"maxSessionsPerMember":null,"metadata":{},"activeMemberCount":1,"ownerPrincipalId":"alice","snapshotVersion":1,"metadataVersion":1,"rosterVersion":1,"presenceVersion":0,"created":{"atEpochMs":1,"actor":{"kind":"service","serviceId":"test"},"reason":null,"traceId":null,"requestId":null},"updated":{"atEpochMs":1,"actor":{"kind":"service","serviceId":"test"},"reason":null,"traceId":null,"requestId":null},"expiresAtEpochMs":null,"emptySinceEpochMs":null,"purgeAfterEpochMs":null,"archived":null,"deleted":null,"lifecycleState":"active","formationEpoch":0},"members":[{"applicationId":"app-1","workspaceId":"workspace-1","groupId":"room-1","principalId":"alice","role":"owner","status":"active","joined":{"atEpochMs":1,"actor":{"kind":"service","serviceId":"test"},"reason":null,"traceId":null,"requestId":null},"updated":{"atEpochMs":1,"actor":{"kind":"service","serviceId":"test"},"reason":null,"traceId":null,"requestId":null},"left":null,"removed":null,"banned":null,"invitedByPrincipalId":null,"invitationExpiresAtEpochMs":null}],"activeSessions":[],"memberCount":1,"onlineMemberCount":0}',
  );
  assert.equal(currentSnapshotReads, 1);
});

Deno.test('group presence response rejects before reading its current snapshot', async () => {
  const snapshot = createGroupStateRouteSnapshot('room-1');
  let currentSnapshotReads = 0;
  const service = createPresenceResponseService(snapshot, () => {
    currentSnapshotReads += 1;
  });
  const ref = { ...TEST_GROUP_SCOPE, groupId: 'room-1' };

  await assert.rejects(
    () =>
      toGroupStateResponse({
        kind: 'presence',
        receipt: {
          commandId: 'rejected-command',
          requestId: 'rejected-request',
          commandHash: 'rejected-hash',
          aggregateRef: ref,
          outcome: 'rejected',
          attemptCount: 1,
          acceptedStorageRevision: null,
          stateRevision: 1,
          snapshotVersion: 1,
          causalRevision: { groupRevision: 1, presenceRevision: 1 },
          eventId: null,
          outboxIds: [],
          joinCode: null,
          joinCodeExpiresAtEpochMs: null,
          rejection: 'Presence rejected by current authority',
        },
        ref,
        service,
      }),
    { message: 'Presence rejected by current authority' },
  );
  assert.equal(currentSnapshotReads, 0);
});

Deno.test(
  'group presence routes retain every AppInbox envelope and post-receipt snapshot read',
  async () => {
    const enqueued: unknown[] = [];
    let currentSnapshotReads = 0;
    const snapshot = createGroupStateRouteSnapshot('room-1');
    const runtime = createGroupStateRouteTestRuntime({
      groupService: {
        readCurrentSnapshot: () => {
          currentSnapshotReads += 1;
          return Promise.resolve(snapshot);
        },
      },
      processGroupAppInbox: capturePresenceReceipt(enqueued),
    });

    const responses = [
      await requestPresenceMutation(runtime.app, PRESENCE_CONNECT_ROUTE, {
        generationId: 'generation-connect',
        principalId: 'forged-principal',
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 2,
        requestId: 'connect-request',
      }),
      await requestPresenceMutation(runtime.app, PRESENCE_HEARTBEAT_ROUTE, {
        generationId: 'generation-heartbeat',
        principalId: 'forged-principal',
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
        lastHeartbeatAtEpochMs: 2,
        expiresAtEpochMs: 3,
        requestId: 'heartbeat-request',
      }),
      await requestPresenceMutation(runtime.app, PRESENCE_DISCONNECT_ROUTE, {
        generationId: 'generation-disconnect',
        principalId: 'forged-principal',
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
        lastHeartbeatAtEpochMs: 3,
        disconnectedAtEpochMs: 4,
        expiresAtEpochMs: 5,
        requestId: 'disconnect-request',
      }),
    ];

    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), snapshot);
    }
    assert.equal(currentSnapshotReads, 3);
    assert.equal(
      JSON.stringify(enqueued),
      '[{"type":"GROUP_PRESENCE_CONNECT","resourceId":"connect-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","sessionId":"alice-session","request":{"generationId":"generation-connect","principalId":"alice","actorPrincipalId":"alice","actorSessionId":"alice-session","connectedAtEpochMs":1,"lastHeartbeatAtEpochMs":1,"expiresAtEpochMs":2,"requestId":"connect-request"}}},{"type":"GROUP_PRESENCE_HEARTBEAT","resourceId":"heartbeat-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","sessionId":"alice-session","request":{"generationId":"generation-heartbeat","principalId":"alice","actorPrincipalId":"alice","actorSessionId":"alice-session","lastHeartbeatAtEpochMs":2,"expiresAtEpochMs":3,"requestId":"heartbeat-request"}}},{"type":"GROUP_PRESENCE_DISCONNECT","resourceId":"disconnect-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","sessionId":"alice-session","request":{"generationId":"generation-disconnect","principalId":"alice","actorPrincipalId":"alice","actorSessionId":"alice-session","lastHeartbeatAtEpochMs":3,"disconnectedAtEpochMs":4,"expiresAtEpochMs":5,"requestId":"disconnect-request"}}}]',
    );
  },
);

Deno.test('group presence route rejects a receipt before its cleanup read', async () => {
  let currentSnapshotReads = 0;
  const runtime = createGroupStateRouteTestRuntime({
    groupService: {
      readCurrentSnapshot: () => {
        currentSnapshotReads += 1;
        return Promise.resolve(createGroupStateRouteSnapshot('room-1'));
      },
    },
    processGroupAppInbox: () =>
      Promise.resolve({
        outcome: 'rejected',
        rejection: 'Presence rejected by current authority',
      } as never),
  });

  const response = await requestPresenceMutation(runtime.app, PRESENCE_CONNECT_ROUTE, {
    generationId: 'generation-1',
    actorPrincipalId: 'forged-actor',
    actorSessionId: 'forged-session',
    connectedAtEpochMs: 1,
    lastHeartbeatAtEpochMs: 1,
    expiresAtEpochMs: 2,
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Presence rejected by current authority' });
  assert.equal(currentSnapshotReads, 0);
});

function createPresenceResponseService(
  snapshot: ReturnType<typeof createGroupStateRouteSnapshot>,
  onCurrentSnapshotRead: () => void,
) {
  return {
    listSnapshots: () => Promise.resolve([]),
    readSnapshot: () => Promise.resolve(undefined),
    readCurrentSnapshot: () => {
      onCurrentSnapshotRead();
      return Promise.resolve(snapshot);
    },
    listEvents: () => Promise.resolve([]),
    listEventPage: () => Promise.resolve({ events: [], hasMore: false }),
  };
}

function capturePresenceReceipt(enqueued: unknown[]): ProcessGroupAppInbox {
  return <V, R>(
    _authority: GroupStateRouteAuthSession,
    entry: AppInboxEnqueueInput<V>,
  ): Promise<R> => {
    enqueued.push(entry);
    return Promise.resolve({
      outcome: 'applied',
      causalRevision: { groupRevision: 1, presenceRevision: 1 },
    } as R);
  };
}

interface PresenceMutationRoute {
  readonly path: string;
  readonly method: 'POST' | 'PUT';
}

async function requestPresenceMutation(
  app: ReturnType<typeof createGroupStateRouteTestRuntime>['app'],
  route: PresenceMutationRoute,
  body: Record<string, unknown>,
): Promise<Response> {
  return await app.request(route.path, {
    method: route.method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

Deno.test('group REST presence lifecycle requires a valid generation before enqueue', async () => {
  const processCalls: unknown[] = [];
  const { app, sessionPath } = createPresenceValidationRuntime(processCalls);

  await verifyMalformedPresenceRequests(app, sessionPath);
  assert.equal(processCalls.length, 0);
  await verifyValidPresenceRequests(app, sessionPath);
  assert.equal(processCalls.length, 3);
});

function createPresenceValidationRuntime(processCalls: unknown[]): {
  readonly app: ReturnType<typeof createPredecessorGroupStateRouteTestRuntime>['app'];
  readonly sessionPath: string;
} {
  const snapshot = createPredecessorGroupStateRouteSnapshot('room-1', ['alice']);
  const { app } = createPredecessorGroupStateRouteTestRuntime({
    session: createPredecessorGroupStateRouteAuthSession('alice'),
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
  return {
    app,
    sessionPath: API_BASE,
  };
}

async function verifyMalformedPresenceRequests(
  app: ReturnType<typeof createPredecessorGroupStateRouteTestRuntime>['app'],
  sessionPath: string,
): Promise<void> {
  const malformed = [
    { method: 'PUT', path: sessionPath, body: {} },
    {
      method: 'POST',
      path: `${sessionPath}/heartbeat`,
      body: { generationId: { forged: true } },
    },
    {
      method: 'POST',
      path: `${sessionPath}/heartbeat`,
      body: { generationId: 'generation-1', lastHeartbeatAtEpochMs: -1 },
    },
    {
      method: 'POST',
      path: `${sessionPath}/disconnect`,
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
      headers: AUTHENTICATED_HEADERS,
      body: JSON.stringify(testCase.body),
    });
    assert.equal(response.status, 400, testCase.path);
    assert.match((await response.json()).error, /Group|group/);
  }
}

async function verifyValidPresenceRequests(
  app: ReturnType<typeof createPredecessorGroupStateRouteTestRuntime>['app'],
  sessionPath: string,
): Promise<void> {
  for (
    const testCase of [
      { method: 'PUT', path: sessionPath },
      { method: 'POST', path: `${sessionPath}/heartbeat` },
      { method: 'POST', path: `${sessionPath}/disconnect` },
    ] as const
  ) {
    const response = await app.request(testCase.path, {
      method: testCase.method,
      headers: AUTHENTICATED_HEADERS,
      body: JSON.stringify({
        generationId: 'generation-1',
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 1,
        ...(testCase.path.endsWith('/disconnect') ? { disconnectedAtEpochMs: 1 } : {}),
      }),
    });
    assert.equal(response.status, 200, testCase.path);
  }
}
