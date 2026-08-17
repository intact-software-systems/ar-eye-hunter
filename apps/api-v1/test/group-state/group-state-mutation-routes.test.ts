import assert from 'node:assert/strict';
import { Either } from '@shared/resilience/Either.ts';
import type {
  GroupCreateAppInboxPayload,
  GroupUpdateAppInboxPayload,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import {
  type AppInboxEnqueueInput,
  AppInboxType,
} from '@shared-server/rallar-system/services/AppInboxService.ts';

import type { ProcessGroupAppInbox } from '../../src/group-state/group-state-route-contracts.ts';
import {
  readGroupStateRouteRequest,
} from '../../src/group-state/read-group-state-route-request.ts';
import { toGroupStateCommand } from '../../src/group-state/to-group-state-command.ts';
import { toGroupStateResponse } from '../../src/group-state/to-group-state-response.ts';
import {
  captureGroupStateRouteWrite,
  createGroupStateRouteAuthSession,
  createGroupStateRouteSnapshot,
  createGroupStateRouteTestRuntime,
  createPredecessorGroupStateRouteAuthSession,
  createPredecessorGroupStateRouteSnapshot,
  createPredecessorGroupStateRouteTestRuntime,
  postGroupStateMutation,
  postGroupStateMutationWithHeaders,
  putGroupStateMutation,
  TEST_GROUP_SCOPE,
  toGroupStateWritten,
} from './group-state-route-test-runtime.ts';

const API_BASE = '/api/state/apps/app-1/workspaces/workspace-1/groups';
const GROUP_ROUTE = `${API_BASE}/room-1`;
const MALFORMED_NON_PRESENCE_ROUTE_CASES = [
  { method: 'POST', path: API_BASE, body: { displayName: 7, kind: 'room', groupId: 'room-2' } },
  { method: 'PUT', path: GROUP_ROUTE, body: { status: 'unknown' } },
  { method: 'POST', path: `${GROUP_ROUTE}/director/appoint`, body: { heartbeatTtlMs: 0 } },
  { method: 'POST', path: `${GROUP_ROUTE}/join`, body: { inviteToken: 7 } },
  { method: 'POST', path: `${GROUP_ROUTE}/invites/accept`, body: { reason: 7 } },
  {
    method: 'POST',
    path: `${GROUP_ROUTE}/join-code/rotate`,
    body: { joinCode: '', expiresAtEpochMs: 0 },
  },
  {
    method: 'POST',
    path: `${GROUP_ROUTE}/invites/bob`,
    body: { invitationExpiresAtEpochMs: -1 },
  },
  { method: 'POST', path: `${GROUP_ROUTE}/invites/bob/revoke`, body: { traceId: 7 } },
  { method: 'POST', path: `${GROUP_ROUTE}/members/bob/remove`, body: { reason: {} } },
  { method: 'POST', path: `${GROUP_ROUTE}/members/bob/ban`, body: { requestId: {} } },
  { method: 'POST', path: `${GROUP_ROUTE}/members/bob/unban`, body: { traceId: [] } },
  { method: 'PUT', path: `${GROUP_ROUTE}/members/bob/role`, body: { role: 'superuser' } },
  { method: 'POST', path: `${GROUP_ROUTE}/owner/transfer`, body: { newOwnerPrincipalId: '' } },
  {
    method: 'PUT',
    path: `${GROUP_ROUTE}/members/alice`,
    body: { status: 'active', invitationExpiresAtEpochMs: -1 },
  },
] as const;
const randomUuidDescriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
const randomUuidAtModuleLoad = crypto.randomUUID;
Deno.test('canonical group request reader retains body request ID precedence', async () => {
  const request = await readGroupStateRouteRequest<{ requestId?: string; name: string }>({
    req: {
      json: () => Promise.resolve({ requestId: 'body-request', name: 'Room' }),
      header: () => 'header-request',
    },
  });
  assert.deepEqual(request, { requestId: 'body-request', name: 'Room' });
});
Deno.test('group create command retains its authenticated AppInbox envelope', () => {
  const command = toGroupStateCommand({
    operation: 'create-group',
    authSession: createGroupStateRouteAuthSession('alice'),
    scope: TEST_GROUP_SCOPE,
    request: {
      groupId: 'room/1',
      displayName: 'Room',
      kind: 'room',
      createdByPrincipalId: 'forged-creator',
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'create-body',
    },
  });
  assert.equal(
    JSON.stringify(command),
    '{"type":"GROUP_CREATE","resourceId":"create-body","contextId":"app-1:workspace-1:room%2F1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"request":{"groupId":"room/1","displayName":"Room","kind":"room","createdByPrincipalId":"alice","actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"create-body"}}}',
  );
});
Deno.test('group command output keeps create payloads isolated from updates', () => {
  const command = toGroupStateCommand({
    operation: 'create-group',
    authSession: createGroupStateRouteAuthSession('alice'),
    scope: TEST_GROUP_SCOPE,
    request: {
      groupId: 'room-1',
      displayName: 'Room',
      kind: 'room',
      createdByPrincipalId: 'forged-creator',
      requestId: 'create-request',
    },
  });
  assert.equal(command.type, AppInboxType.GROUP_CREATE);
  if (command.type === AppInboxType.GROUP_CREATE) {
    const payload: GroupCreateAppInboxPayload = command.data;
    assert.equal(payload.request.groupId, 'room-1');
    // @ts-expect-error A create enqueue is not a group-update payload.
    const invalidPayload: GroupUpdateAppInboxPayload = command.data;
    void invalidPayload;
  }
});
Deno.test('group aggregate commands retain update and director envelopes', () => {
  const authSession = createGroupStateRouteAuthSession('alice');
  const commands = [
    toGroupStateCommand({
      operation: 'update-group',
      authSession,
      scope: TEST_GROUP_SCOPE,
      groupId: 'room-2',
      request: {
        displayName: 'Renamed',
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
        requestId: 'update-body',
      },
    }),
    toGroupStateCommand({
      operation: 'appoint-group-director',
      authSession,
      scope: TEST_GROUP_SCOPE,
      groupId: 'room-3',
      request: {
        heartbeatTtlMs: 20,
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
        requestId: 'appoint-body',
      },
    }),
  ];
  assert.equal(
    JSON.stringify(commands),
    '[{"type":"GROUP_UPDATE","resourceId":"update-body","contextId":"app-1:workspace-1:room-2","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-2","request":{"displayName":"Renamed","actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"update-body"}}},{"type":"GROUP_DIRECTOR_APPOINT","resourceId":"appoint-body","contextId":"app-1:workspace-1:room-3","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-3","request":{"heartbeatTtlMs":20,"actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"appoint-body"}}}]',
  );
});
Deno.test('group mutation response retains snapshot identity and durable error text', () => {
  const snapshot = createGroupStateRouteSnapshot('room-1');
  const response = toGroupStateResponse({
    kind: 'mutation',
    written: toGroupStateWritten(snapshot),
  });
  assert.strictEqual(response.snapshot, snapshot);
  assert.equal(
    JSON.stringify(response.snapshot),
    '{"stateRevision":1,"causalRevision":{"groupRevision":1,"presenceRevision":0},"group":{"applicationId":"app-1","workspaceId":"workspace-1","groupId":"room-1","slug":null,"displayName":"room-1","description":null,"kind":"room","status":"active","joinMode":"open","maxMembers":null,"maxSessionsPerMember":null,"metadata":{},"activeMemberCount":1,"ownerPrincipalId":"alice","snapshotVersion":1,"metadataVersion":1,"rosterVersion":1,"presenceVersion":0,"created":{"atEpochMs":1,"actor":{"kind":"service","serviceId":"test"},"reason":null,"traceId":null,"requestId":null},"updated":{"atEpochMs":1,"actor":{"kind":"service","serviceId":"test"},"reason":null,"traceId":null,"requestId":null},"expiresAtEpochMs":null,"emptySinceEpochMs":null,"purgeAfterEpochMs":null,"archived":null,"deleted":null,"lifecycleState":"active"},"members":[{"applicationId":"app-1","workspaceId":"workspace-1","groupId":"room-1","principalId":"alice","role":"owner","status":"active","joined":{"atEpochMs":1,"actor":{"kind":"service","serviceId":"test"},"reason":null,"traceId":null,"requestId":null},"updated":{"atEpochMs":1,"actor":{"kind":"service","serviceId":"test"},"reason":null,"traceId":null,"requestId":null},"left":null,"removed":null,"banned":null,"invitedByPrincipalId":null,"invitationExpiresAtEpochMs":null}],"activeSessions":[],"memberCount":1,"onlineMemberCount":0}',
  );
  assert.throws(
    () =>
      toGroupStateResponse({
        kind: 'mutation',
        written: { status: 'error', result: Either.ofLeft('Mutation result rejected') },
      }),
    { message: 'Mutation result rejected' },
  );
});
Deno.test('group aggregate routes retain their AppInbox envelopes', async () => {
  const enqueued: unknown[] = [];
  const snapshot = createGroupStateRouteSnapshot('room-1');
  const runtime = createGroupStateRouteTestRuntime({
    groupService: { readSnapshot: () => Promise.resolve(snapshot) },
    processGroupAppInbox: captureGroupStateRouteWrite(enqueued, snapshot),
  });
  const responses = [
    await postGroupStateMutation(runtime.app, API_BASE, {
      groupId: 'room/1',
      displayName: 'Room',
      kind: 'room',
      createdByPrincipalId: 'forged-creator',
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'create-body',
    }),
    await putGroupStateMutation(runtime.app, `${API_BASE}/room-2`, {
      displayName: 'Renamed',
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'update-body',
    }),
    await postGroupStateMutation(runtime.app, `${API_BASE}/room-3/director/appoint`, {
      heartbeatTtlMs: 20,
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'appoint-body',
    }),
  ];
  assert.equal(responses[0].status, 201);
  assert.equal(responses[1].status, 200);
  assert.equal(responses[2].status, 200);
  assert.equal(
    JSON.stringify(enqueued),
    '[{"type":"GROUP_CREATE","resourceId":"create-body","contextId":"app-1:workspace-1:room%2F1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"request":{"groupId":"room/1","displayName":"Room","kind":"room","createdByPrincipalId":"alice","actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"create-body"}}},{"type":"GROUP_UPDATE","resourceId":"update-body","contextId":"app-1:workspace-1:room-2","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-2","request":{"displayName":"Renamed","actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"update-body"}}},{"type":"GROUP_DIRECTOR_APPOINT","resourceId":"appoint-body","contextId":"app-1:workspace-1:room-3","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-3","request":{"heartbeatTtlMs":20,"actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"appoint-body"}}}]',
  );
});
Deno.test(
  'group aggregate routes preserve body, header, then one generated request ID',
  async () => {
    const enqueued: unknown[] = [];
    const snapshot = createGroupStateRouteSnapshot('room-1');
    const runtime = createGroupStateRouteTestRuntime({
      processGroupAppInbox: captureGroupStateRouteWrite(enqueued, snapshot),
    });
    await withRandomUuid('generated-request', async (readRandomCallCount) => {
      const bodyResponse = await postGroupStateMutationWithHeaders(runtime.app, API_BASE, {
        body: {
          groupId: 'body-id-group',
          displayName: 'Body',
          kind: 'room',
          requestId: 'body-request',
        },
        headers: { 'Idempotency-Key': 'header-request' },
      });
      const headerResponse = await postGroupStateMutationWithHeaders(runtime.app, API_BASE, {
        body: {
          groupId: 'header-id-group',
          displayName: 'Header',
          kind: 'room',
        },
        headers: { 'Idempotency-Key': 'header-request' },
      });
      const generatedResponse = await postGroupStateMutation(runtime.app, API_BASE, {
        groupId: 'generated-id-group',
        displayName: 'Generated',
        kind: 'room',
      });
      assert.equal(bodyResponse.status, 201);
      assert.equal(headerResponse.status, 201);
      assert.equal(generatedResponse.status, 201);
      assert.equal(readRandomCallCount(), 1);
    });
    assert.equal(
      JSON.stringify(enqueued.map((entry) => {
        const envelope = entry as AppInboxEnqueueInput<unknown>;
        return [envelope.resourceId, envelope.data];
      })),
      '[["body-request",{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"request":{"groupId":"body-id-group","displayName":"Body","kind":"room","requestId":"body-request","createdByPrincipalId":"alice","actorPrincipalId":"alice","actorSessionId":"alice-session"}}],["header-request",{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"request":{"groupId":"header-id-group","displayName":"Header","kind":"room","requestId":"header-request","createdByPrincipalId":"alice","actorPrincipalId":"alice","actorSessionId":"alice-session"}}],["generated-request",{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"request":{"groupId":"generated-id-group","displayName":"Generated","kind":"room","requestId":"generated-request","createdByPrincipalId":"alice","actorPrincipalId":"alice","actorSessionId":"alice-session"}}]]',
    );
  },
);
Deno.test(
  'group aggregate request ID UUID stub restores crypto randomUUID observable shape',
  () => {
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(crypto, 'randomUUID'),
      randomUuidDescriptor,
    );
    assert.equal(crypto.randomUUID, randomUuidAtModuleLoad);
    assert.notEqual(crypto.randomUUID(), 'generated-request');
  },
);
Deno.test(
  'group aggregate route waits for AppInbox completion before its normal response',
  async () => {
    let resolveCompletion: (() => void) | undefined;
    let enqueued = 0;
    const snapshot = createGroupStateRouteSnapshot('room-1');
    const runtime = createGroupStateRouteTestRuntime({
      processGroupAppInbox: <V, R>(
        _authority: Parameters<ProcessGroupAppInbox>[0],
        _entry: AppInboxEnqueueInput<V>,
      ): Promise<R> =>
        new Promise((resolve) => {
          enqueued += 1;
          resolveCompletion = () => resolve(toGroupStateWritten(snapshot) as R);
        }),
    });
    const responsePromise = postGroupStateMutation(runtime.app, API_BASE, {
      groupId: 'room-1',
      displayName: 'Room',
      kind: 'room',
      requestId: 'await-completion',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(enqueued, 1);
    assert.ok(resolveCompletion);
    resolveCompletion();
    const response = await responsePromise;
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), snapshot);
  },
);
Deno.test(
  'group aggregate route stops at route authentication failure before AppInbox',
  async () => {
    let enqueued = 0;
    const runtime = createGroupStateRouteTestRuntime({
      installStateAuthentication: false,
      requireApiAuthSession: () => Promise.reject(new Error('route authentication failed')),
      processGroupAppInbox: () => {
        enqueued += 1;
        return Promise.resolve(undefined as never);
      },
    });
    const response = await postGroupStateMutation(runtime.app, API_BASE, {
      groupId: 'room-1',
      displayName: 'Room',
      kind: 'room',
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'route authentication failed' });
    assert.equal(enqueued, 0);
  },
);
Deno.test(
  'group aggregate route serializes AppInbox failure after the awaited completion',
  async () => {
    const failure = Object.assign(new Error('group command rejected'), {
      code: 'group-command-rejected',
      status: 409,
      details: { groupId: 'room-1' },
    });
    const runtime = createGroupStateRouteTestRuntime({
      processGroupAppInbox: () => Promise.reject(failure),
    });
    const response = await postGroupStateMutation(runtime.app, API_BASE, {
      groupId: 'room-1',
      displayName: 'Room',
      kind: 'room',
    });
    assert.equal(response.status, 409);
    assert.equal(
      JSON.stringify(await response.json()),
      '{"error":"group command rejected","code":"group-command-rejected"}',
    );
  },
);
async function withRandomUuid(
  value: string,
  action: (readCallCount: () => number) => Promise<void>,
): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  let callCount = 0;
  Object.defineProperty(crypto, 'randomUUID', {
    configurable: true,
    value: () => {
      callCount += 1;
      return value;
    },
  });
  try {
    await action(() => callCount);
  } finally {
    if (descriptor) {
      Object.defineProperty(crypto, 'randomUUID', descriptor);
    } else {
      Reflect.deleteProperty(crypto, 'randomUUID');
    }
  }
}
Deno.test(
  'all non-presence group REST mutations reject malformed bodies before inbox ' +
    'enqueue',
  async () => {
    const processCalls: unknown[] = [];
    const snapshot = createPredecessorGroupStateRouteSnapshot('room-1', ['alice']);
    const ownerSnapshot = {
      ...snapshot,
      members: snapshot.members.map((member) => ({ ...member, role: 'owner' as const })),
    };
    const { app } = createPredecessorGroupStateRouteTestRuntime({
      session: createPredecessorGroupStateRouteAuthSession('alice'),
      groupService: {
        readSnapshot: () => Promise.resolve(ownerSnapshot),
      },
      processGroupAppInbox: (_authority, input) => {
        processCalls.push(input);
        return Promise.reject(new Error('Malformed request reached group inbox'));
      },
    });
    for (const testCase of MALFORMED_NON_PRESENCE_ROUTE_CASES) {
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
  },
);
