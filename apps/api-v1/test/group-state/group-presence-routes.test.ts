import assert from 'node:assert/strict';

import type { AppInboxEnqueueInput } from '@shared-server/rallar-system/services/AppInboxService.ts';
import { toGroupStateCommand } from '../../src/group-state/to-group-state-command.ts';
import { toGroupStateResponse } from '../../src/group-state/to-group-state-response.ts';
import type {
  GroupStateRouteAuthSession,
  ProcessGroupAppInbox,
} from '../../src/group-state/group-state-route-contracts.ts';

import {
  createGroupStateRouteAuthSession,
  createGroupStateRouteSnapshot,
  createGroupStateRouteTestDependencies,
  createGroupStateRouteTestRuntime,
  createPredecessorGroupStateRouteAuthSession,
  createPredecessorGroupStateRouteSnapshot,
  createPredecessorGroupStateRouteTestRuntime,
  TEST_GROUP_SCOPE,
  withStrictGroupStateRouteReadAuth,
} from './group-state-route-test-runtime.ts';

const API_BASE =
  '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/sessions/alice-session';

Deno.test('group presence commands retain validation and authenticated envelopes', () => {
  const authSession = createGroupStateRouteAuthSession('alice');
  const commands = [
    toGroupStateCommand({
      operation: 'connect-group-presence',
      authSession,
      scope: TEST_GROUP_SCOPE,
      groupId: 'room-1',
      sessionId: 'alice-session',
      request: {
        generationId: 'generation-connect',
        principalId: 'forged-principal',
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 2,
        requestId: 'connect-request',
      },
    }),
    toGroupStateCommand({
      operation: 'heartbeat-group-presence',
      authSession,
      scope: TEST_GROUP_SCOPE,
      groupId: 'room-1',
      sessionId: 'alice-session',
      request: {
        generationId: 'generation-heartbeat',
        principalId: 'forged-principal',
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
        lastHeartbeatAtEpochMs: 2,
        expiresAtEpochMs: 3,
        requestId: 'heartbeat-request',
      },
    }),
    toGroupStateCommand({
      operation: 'disconnect-group-presence',
      authSession,
      scope: TEST_GROUP_SCOPE,
      groupId: 'room-1',
      sessionId: 'alice-session',
      request: {
        generationId: 'generation-disconnect',
        principalId: 'forged-principal',
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
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

Deno.test('group presence response rejects before reading and retains the current snapshot', async () => {
  const snapshot = createGroupStateRouteSnapshot('room-1');
  let currentSnapshotReads = 0;
  const service = {
    listSnapshots: () => Promise.resolve([]),
    readSnapshot: () => Promise.resolve(undefined),
    readCurrentSnapshot: () => {
      currentSnapshotReads += 1;
      return Promise.resolve(snapshot);
    },
    listEvents: () => Promise.resolve([]),
    listEventPage: () => Promise.resolve({ events: [], hasMore: false }),
  };
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
    '{"stateRevision":1,"causalRevision":{"groupRevision":1,"presenceRevision":0},"group":{"applicationId":"app-1","workspaceId":"workspace-1","groupId":"room-1","slug":null,"displayName":"room-1","description":null,"kind":"room","status":"active","joinMode":"open","maxMembers":null,"maxSessionsPerMember":null,"metadata":{},"activeMemberCount":1,"ownerPrincipalId":"alice","snapshotVersion":1,"metadataVersion":1,"rosterVersion":1,"presenceVersion":0,"created":{"atEpochMs":1,"actor":{"kind":"service","serviceId":"test"},"reason":null,"traceId":null,"requestId":null},"updated":{"atEpochMs":1,"actor":{"kind":"service","serviceId":"test"},"reason":null,"traceId":null,"requestId":null},"expiresAtEpochMs":null,"emptySinceEpochMs":null,"purgeAfterEpochMs":null,"archived":null,"deleted":null},"members":[{"applicationId":"app-1","workspaceId":"workspace-1","groupId":"room-1","principalId":"alice","role":"owner","status":"active","joined":{"atEpochMs":1,"actor":{"kind":"service","serviceId":"test"},"reason":null,"traceId":null,"requestId":null},"updated":{"atEpochMs":1,"actor":{"kind":"service","serviceId":"test"},"reason":null,"traceId":null,"requestId":null},"left":null,"removed":null,"banned":null,"invitedByPrincipalId":null,"invitationExpiresAtEpochMs":null}],"activeSessions":[],"memberCount":1,"onlineMemberCount":0}',
  );
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
  assert.equal(currentSnapshotReads, 1);
});

Deno.test('group presence routes retain every AppInbox envelope and post-receipt snapshot read', async () => {
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
    await requestPresenceMutation(runtime.app, API_BASE, 'PUT', {
      generationId: 'generation-connect',
      principalId: 'forged-principal',
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      connectedAtEpochMs: 1,
      lastHeartbeatAtEpochMs: 1,
      expiresAtEpochMs: 2,
      requestId: 'connect-request',
    }),
    await requestPresenceMutation(runtime.app, `${API_BASE}/heartbeat`, 'POST', {
      generationId: 'generation-heartbeat',
      principalId: 'forged-principal',
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      lastHeartbeatAtEpochMs: 2,
      expiresAtEpochMs: 3,
      requestId: 'heartbeat-request',
    }),
    await requestPresenceMutation(runtime.app, `${API_BASE}/disconnect`, 'POST', {
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
});

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

  const response = await requestPresenceMutation(runtime.app, API_BASE, 'PUT', {
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

async function requestPresenceMutation(
  app: ReturnType<typeof createGroupStateRouteTestRuntime>['app'],
  path: string,
  method: 'POST' | 'PUT',
  body: Record<string, unknown>,
): Promise<Response> {
  return await app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

Deno.test('group REST presence lifecycle requires a valid generation before enqueue', async () => {
  const processCalls: unknown[] = [];
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
