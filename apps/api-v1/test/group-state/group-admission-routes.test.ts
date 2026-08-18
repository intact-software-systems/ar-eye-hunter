import assert from 'node:assert/strict';

import { Either } from '@shared/resilience/Either.ts';
import {
  type AppInboxEnqueueInput,
  AppInboxType,
} from '@shared-server/rallar-system/services/AppInboxService.ts';

import type { ProcessGroupAppInbox } from '../../src/group-state/group-state-route-contracts.ts';
import { toGroupStateCommand } from '../../src/group-state/to-group-state-command.ts';
import { toGroupStateResponse } from '../../src/group-state/to-group-state-response.ts';
import {
  captureGroupStateRouteWrite,
  createGroupStateRouteAuthSession,
  createGroupStateRouteEvent,
  createGroupStateRouteSnapshot,
  createGroupStateRouteTestRuntime,
  createPredecessorGroupStateRouteAuthSession,
  createPredecessorGroupStateRouteSnapshot,
  createPredecessorGroupStateRouteTestRuntime,
  postGroupStateMutation,
  postGroupStateMutationWithHeaders,
  TEST_GROUP_SCOPE,
  withStrictGroupStateRouteReadAuth,
} from './group-state-route-test-runtime.ts';

const API_BASE = '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1';
const AUTHENTICATED_HEADERS = { authorization: 'Bearer token' } as const;
Deno.test('group admission commands retain every authenticated AppInbox envelope', () => {
  const authSession = createGroupStateRouteAuthSession('alice');
  const commandBase = { authSession, scope: TEST_GROUP_SCOPE, groupId: 'room-1' } as const;
  const forgedActor = { actorPrincipalId: 'forged-actor', actorSessionId: 'forged-session' };
  const commands = [
    toGroupStateCommand({
      operation: 'join-group',
      ...commandBase,
      request: {
        inviteToken: 'invite-1',
        joinCode: 'code-1',
        ...forgedActor,
        requestId: 'join-request',
      },
    }),
    toGroupStateCommand({
      operation: 'accept-group-invite',
      ...commandBase,
      request: {
        ...forgedActor,
        requestId: 'accept-request',
      },
    }),
    toGroupStateCommand({
      operation: 'rotate-group-join-code',
      ...commandBase,
      request: {
        joinCode: 'next-code',
        expiresAtEpochMs: 2000,
        ...forgedActor,
        requestId: 'rotate-request',
      },
    }),
    toGroupStateCommand({
      operation: 'create-group-invite',
      ...commandBase,
      principalId: 'bob',
      request: {
        invitationExpiresAtEpochMs: 2000,
        ...forgedActor,
        requestId: 'invite-request',
      },
    }),
    toGroupStateCommand({
      operation: 'revoke-group-invite',
      ...commandBase,
      principalId: 'bob',
      request: {
        ...forgedActor,
        requestId: 'revoke-request',
      },
    }),
  ];
  assert.equal(
    JSON.stringify(commands),
    '[{"type":"GROUP_JOIN","resourceId":"join-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","request":{"inviteToken":"invite-1","joinCode":"code-1","actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"join-request"}}},{"type":"GROUP_INVITE_ACCEPT","resourceId":"accept-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","request":{"actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"accept-request"}}},{"type":"GROUP_JOIN_CODE_ROTATE","resourceId":"rotate-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","request":{"joinCode":"next-code","expiresAtEpochMs":2000,"actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"rotate-request"}}},{"type":"GROUP_INVITE_CREATE","resourceId":"invite-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","principalId":"bob","request":{"invitationExpiresAtEpochMs":2000,"actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"invite-request"}}},{"type":"GROUP_INVITE_REVOKE","resourceId":"revoke-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","principalId":"bob","request":{"actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"revoke-request"}}}]',
  );
});
Deno.test('group join-code response omits its event without changing JSON order', () => {
  const snapshot = createGroupStateRouteSnapshot('room-1');
  const response = toGroupStateResponse({
    kind: 'join-code',
    written: {
      status: 'ok',
      result: Either.ofRight({
        joinCode: 'next-code',
        expiresAtEpochMs: 2000,
        snapshot,
        event: createGroupStateRouteEvent('join-code-event'),
      }),
    },
  });
  assert.strictEqual(response.snapshot, snapshot);
  assert.equal(
    JSON.stringify(response),
    '{"joinCode":"next-code","expiresAtEpochMs":2000,"snapshot":{"stateRevision":1,"causalRevision":{"groupRevision":1,"presenceRevision":0},"group":{"applicationId":"app-1","workspaceId":"workspace-1","groupId":"room-1","slug":null,"displayName":"room-1","description":null,"kind":"room","status":"active","joinMode":"open","maxMembers":null,"maxSessionsPerMember":null,"metadata":{},"activeMemberCount":1,"ownerPrincipalId":"alice","snapshotVersion":1,"metadataVersion":1,"rosterVersion":1,"presenceVersion":0,"created":{"atEpochMs":1,"actor":{"kind":"service","serviceId":"test"},"reason":null,"traceId":null,"requestId":null},"updated":{"atEpochMs":1,"actor":{"kind":"service","serviceId":"test"},"reason":null,"traceId":null,"requestId":null},"expiresAtEpochMs":null,"emptySinceEpochMs":null,"purgeAfterEpochMs":null,"archived":null,"deleted":null,"lifecycleState":"active"},"members":[{"applicationId":"app-1","workspaceId":"workspace-1","groupId":"room-1","principalId":"alice","role":"owner","status":"active","joined":{"atEpochMs":1,"actor":{"kind":"service","serviceId":"test"},"reason":null,"traceId":null,"requestId":null},"updated":{"atEpochMs":1,"actor":{"kind":"service","serviceId":"test"},"reason":null,"traceId":null,"requestId":null},"left":null,"removed":null,"banned":null,"invitedByPrincipalId":null,"invitationExpiresAtEpochMs":null}],"activeSessions":[],"memberCount":1,"onlineMemberCount":0}}',
  );
});
Deno.test('group admission routes retain every AppInbox envelope and actor override', async () => {
  const enqueued: unknown[] = [];
  const snapshot = createGroupStateRouteSnapshot('room-1');
  const runtime = createGroupStateRouteTestRuntime({
    processGroupAppInbox: captureGroupStateRouteWrite(enqueued, snapshot),
  });
  const responses = [
    await postGroupStateMutation(runtime.app, `${API_BASE}/join`, {
      inviteToken: 'invite-1',
      joinCode: 'code-1',
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'join-request',
    }),
    await postGroupStateMutation(runtime.app, `${API_BASE}/invites/accept`, {
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'accept-request',
    }),
    await postGroupStateMutation(runtime.app, `${API_BASE}/join-code/rotate`, {
      joinCode: 'next-code',
      expiresAtEpochMs: 2000,
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'rotate-request',
    }),
    await postGroupStateMutation(runtime.app, `${API_BASE}/invites/bob`, {
      invitationExpiresAtEpochMs: 2000,
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'invite-request',
    }),
    await postGroupStateMutation(runtime.app, `${API_BASE}/invites/bob/revoke`, {
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'revoke-request',
    }),
  ];
  for (const response of responses) {
    assert.equal(response.status, 200);
  }
  assert.equal(
    JSON.stringify(enqueued),
    '[{"type":"GROUP_JOIN","resourceId":"join-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","request":{"inviteToken":"invite-1","joinCode":"code-1","actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"join-request"}}},{"type":"GROUP_INVITE_ACCEPT","resourceId":"accept-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","request":{"actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"accept-request"}}},{"type":"GROUP_JOIN_CODE_ROTATE","resourceId":"rotate-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","request":{"joinCode":"next-code","expiresAtEpochMs":2000,"actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"rotate-request"}}},{"type":"GROUP_INVITE_CREATE","resourceId":"invite-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","principalId":"bob","request":{"invitationExpiresAtEpochMs":2000,"actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"invite-request"}}},{"type":"GROUP_INVITE_REVOKE","resourceId":"revoke-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","principalId":"bob","request":{"actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"revoke-request"}}}]',
  );
});
Deno.test('group join route enqueues explicit join intent with authenticated actor', async () => {
  await withStrictGroupStateRouteReadAuth(false, async () => {
    const snapshot = createPredecessorGroupStateRouteSnapshot('room-1', ['alice']);
    const enqueued: AppInboxEnqueueInput<unknown>[] = [];
    const { app } = createPredecessorGroupStateRouteTestRuntime({
      session: createPredecessorGroupStateRouteAuthSession('alice'),
      groupService: {},
      processGroupAppInbox: capturePredecessorGroupWrite(enqueued, { snapshot }),
    });
    const response = await postGroupStateMutationWithHeaders(app, `${API_BASE}/join`, {
      headers: AUTHENTICATED_HEADERS,
      body: {
        inviteToken: 'invite-1',
        joinCode: 'code-1',
        requestId: 'join-request-1',
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), snapshot);
    assert.equal(enqueued.length, 1);
    assert.deepEqual(enqueued[0], {
      type: AppInboxType.GROUP_JOIN,
      resourceId: 'join-request-1',
      contextId: 'app-1:workspace-1:room-1',
      senderId: 'alice',
      data: {
        scope: TEST_GROUP_SCOPE,
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
Deno.test(
  'group invite routes enqueue safe invite workflows with authenticated actors',
  () => withStrictGroupStateRouteReadAuth(false, verifyGroupInviteRoutes),
);
Deno.test('group join-code route enqueues rotation workflow with authenticated actor', async () => {
  await withStrictGroupStateRouteReadAuth(false, async () => {
    const snapshot = createPredecessorGroupStateRouteSnapshot('room-1', ['alice']);
    const responseBody = { joinCode: 'code-1', expiresAtEpochMs: 2_000, snapshot };
    const enqueued: AppInboxEnqueueInput<unknown>[] = [];
    const { app } = createPredecessorGroupStateRouteTestRuntime({
      session: createPredecessorGroupStateRouteAuthSession('alice'),
      groupService: {},
      processGroupAppInbox: capturePredecessorGroupWrite(enqueued, responseBody),
    });
    const response = await postGroupStateMutationWithHeaders(
      app,
      `${API_BASE}/join-code/rotate`,
      {
        headers: AUTHENTICATED_HEADERS,
        body: {
          joinCode: 'code-1',
          expiresAtEpochMs: 2_000,
          requestId: 'rotate-code-1',
        },
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
          scope: TEST_GROUP_SCOPE,
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

async function verifyGroupInviteRoutes(): Promise<void> {
  const snapshot = createPredecessorGroupStateRouteSnapshot('room-1', ['alice']);
  const enqueued: AppInboxEnqueueInput<unknown>[] = [];
  const { app } = createPredecessorGroupStateRouteTestRuntime({
    session: createPredecessorGroupStateRouteAuthSession('alice'),
    groupService: {},
    processGroupAppInbox: capturePredecessorGroupWrite(enqueued, { snapshot }),
  });
  const createResponse = await postGroupStateMutationWithHeaders(app, `${API_BASE}/invites/bob`, {
    headers: AUTHENTICATED_HEADERS,
    body: { invitationExpiresAtEpochMs: 2_000, requestId: 'invite-create-1' },
  });
  const revokeResponse = await postGroupStateMutationWithHeaders(
    app,
    `${API_BASE}/invites/bob/revoke`,
    { headers: AUTHENTICATED_HEADERS, body: { requestId: 'invite-revoke-1' } },
  );
  const acceptResponse = await postGroupStateMutationWithHeaders(
    app,
    `${API_BASE}/invites/accept`,
    { headers: AUTHENTICATED_HEADERS, body: { requestId: 'invite-accept-1' } },
  );

  assert.equal(createResponse.status, 200);
  assert.equal(revokeResponse.status, 200);
  assert.equal(acceptResponse.status, 200);
  assertGroupInviteEnvelopes(enqueued);
}

function assertGroupInviteEnvelopes(enqueued: AppInboxEnqueueInput<unknown>[]): void {
  assert.deepEqual(enqueued, [
    {
      type: AppInboxType.GROUP_INVITE_CREATE,
      resourceId: 'invite-create-1',
      contextId: 'app-1:workspace-1:room-1',
      senderId: 'alice',
      data: {
        scope: TEST_GROUP_SCOPE,
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
        scope: TEST_GROUP_SCOPE,
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
        scope: TEST_GROUP_SCOPE,
        groupId: 'room-1',
        request: {
          actorPrincipalId: 'alice',
          actorSessionId: 'alice-session',
          requestId: 'invite-accept-1',
        },
      },
    },
  ]);
}

function capturePredecessorGroupWrite(
  enqueued: AppInboxEnqueueInput<unknown>[],
  right: unknown,
): ProcessGroupAppInbox {
  return <V, R>(
    _authority: Parameters<ProcessGroupAppInbox>[0],
    input: AppInboxEnqueueInput<V>,
  ): Promise<R> => {
    enqueued.push(input);
    return Promise.resolve({ status: 'ok', result: { right } } as R);
  };
}
