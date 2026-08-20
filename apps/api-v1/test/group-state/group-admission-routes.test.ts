import assert from 'node:assert/strict';

import { Either } from '@shared/resilience/Either.ts';
// prettier-ignore
import type {
  AuthenticatedGroupMutationEnqueue,
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
// prettier-ignore
import type {
  GroupStateInboxDurableResult,
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';

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
  toGroupStateWritten,
  withStrictGroupStateRouteReadAuth,
} from './group-state-route-test-runtime.ts';

const API_BASE = '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1';
const AUTHENTICATED_HEADERS = { authorization: 'Bearer token' } as const;
const EXPECTED_ADMISSION_COMMANDS = [
  {
    type: AppInboxType.GROUP_JOIN,
    topicId: AppInboxType.GROUP_JOIN,
    resourceId: 'group-route-join-request',
    contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
    senderId: 'alice',
    data: {
      scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
      groupId: 'room-1',
      request: {
        inviteToken: 'invite-1',
        joinCode: 'code-1',
        actorPrincipalId: 'alice',
        actorSessionId: 'alice-session',
        requestId: 'group-route-join-request',
      },
    },
  },
  {
    type: AppInboxType.GROUP_INVITE_ACCEPT,
    topicId: AppInboxType.GROUP_INVITE_ACCEPT,
    resourceId: 'group-route-accept-request',
    contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
    senderId: 'alice',
    data: {
      scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
      groupId: 'room-1',
      request: {
        actorPrincipalId: 'alice',
        actorSessionId: 'alice-session',
        requestId: 'group-route-accept-request',
      },
    },
  },
  {
    type: AppInboxType.GROUP_JOIN_CODE_ROTATE,
    topicId: AppInboxType.GROUP_JOIN_CODE_ROTATE,
    resourceId: 'group-route-rotate-request',
    contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
    senderId: 'alice',
    data: {
      scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
      groupId: 'room-1',
      request: {
        joinCode: 'next-code',
        expiresAtEpochMs: 2000,
        actorPrincipalId: 'alice',
        actorSessionId: 'alice-session',
        requestId: 'group-route-rotate-request',
      },
    },
  },
  {
    type: AppInboxType.GROUP_INVITE_CREATE,
    topicId: AppInboxType.GROUP_INVITE_CREATE,
    resourceId: 'group-route-invite-request',
    contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
    senderId: 'alice',
    data: {
      scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
      groupId: 'room-1',
      principalId: 'bob',
      request: {
        invitationExpiresAtEpochMs: 2000,
        actorPrincipalId: 'alice',
        actorSessionId: 'alice-session',
        requestId: 'group-route-invite-request',
      },
    },
  },
  {
    type: AppInboxType.GROUP_INVITE_REVOKE,
    topicId: AppInboxType.GROUP_INVITE_REVOKE,
    resourceId: 'group-route-revoke-request',
    contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
    senderId: 'alice',
    data: {
      scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
      groupId: 'room-1',
      principalId: 'bob',
      request: {
        actorPrincipalId: 'alice',
        actorSessionId: 'alice-session',
        requestId: 'group-route-revoke-request',
      },
    },
  },
] satisfies readonly AuthenticatedGroupMutationEnqueue[];

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
        requestId: 'group-route-join-request',
      },
    }),
    toGroupStateCommand({
      operation: 'accept-group-invite',
      ...commandBase,
      request: {
        ...forgedActor,
        requestId: 'group-route-accept-request',
      },
    }),
    toGroupStateCommand({
      operation: 'rotate-group-join-code',
      ...commandBase,
      request: {
        joinCode: 'next-code',
        expiresAtEpochMs: 2000,
        ...forgedActor,
        requestId: 'group-route-rotate-request',
      },
    }),
    toGroupStateCommand({
      operation: 'create-group-invite',
      ...commandBase,
      principalId: 'bob',
      request: {
        invitationExpiresAtEpochMs: 2000,
        ...forgedActor,
        requestId: 'group-route-invite-request',
      },
    }),
    toGroupStateCommand({
      operation: 'revoke-group-invite',
      ...commandBase,
      principalId: 'bob',
      request: {
        ...forgedActor,
        requestId: 'group-route-revoke-request',
      },
    }),
  ];
  assert.deepEqual(commands, EXPECTED_ADMISSION_COMMANDS);
});
Deno.test('group join-code response omits its event while preserving response fields', () => {
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
  assert.deepEqual(response, {
    joinCode: 'next-code',
    expiresAtEpochMs: 2000,
    snapshot,
  });
});
Deno.test('group admission routes retain every AppInbox envelope and actor override', async () => {
  const enqueued: AuthenticatedGroupMutationEnqueue[] = [];
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
      requestId: 'group-route-join-request',
    }),
    await postGroupStateMutation(runtime.app, `${API_BASE}/invites/accept`, {
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'group-route-accept-request',
    }),
    await postGroupStateMutation(runtime.app, `${API_BASE}/join-code/rotate`, {
      joinCode: 'next-code',
      expiresAtEpochMs: 2000,
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'group-route-rotate-request',
    }),
    await postGroupStateMutation(runtime.app, `${API_BASE}/invites/bob`, {
      invitationExpiresAtEpochMs: 2000,
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'group-route-invite-request',
    }),
    await postGroupStateMutation(runtime.app, `${API_BASE}/invites/bob/revoke`, {
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'group-route-revoke-request',
    }),
  ];
  for (const response of responses) {
    assert.equal(response.status, 200);
  }
  assert.deepEqual(enqueued, EXPECTED_ADMISSION_COMMANDS);
});
Deno.test('group join route enqueues explicit join intent with authenticated actor', async () => {
  await withStrictGroupStateRouteReadAuth(false, async () => {
    const snapshot = createPredecessorGroupStateRouteSnapshot('room-1', ['alice']);
    const enqueued: AuthenticatedGroupMutationEnqueue[] = [];
    const { app } = createPredecessorGroupStateRouteTestRuntime({
      session: createPredecessorGroupStateRouteAuthSession('alice'),
      groupService: {},
      processGroupAppInbox: capturePredecessorGroupWrite(enqueued, toGroupStateWritten(snapshot)),
    });
    const response = await postGroupStateMutationWithHeaders(app, `${API_BASE}/join`, {
      headers: AUTHENTICATED_HEADERS,
      body: {
        inviteToken: 'invite-1',
        joinCode: 'code-1',
        requestId: 'group-route-join-request-1',
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), snapshot);
    assert.equal(enqueued.length, 1);
    assert.deepEqual(enqueued[0], {
      type: AppInboxType.GROUP_JOIN,
      topicId: AppInboxType.GROUP_JOIN,
      resourceId: 'group-route-join-request-1',
      contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
      senderId: 'alice',
      data: {
        scope: TEST_GROUP_SCOPE,
        groupId: 'room-1',
        request: {
          inviteToken: 'invite-1',
          joinCode: 'code-1',
          actorPrincipalId: 'alice',
          actorSessionId: 'alice-session',
          requestId: 'group-route-join-request-1',
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
    const enqueued: AuthenticatedGroupMutationEnqueue[] = [];
    const { app } = createPredecessorGroupStateRouteTestRuntime({
      session: createPredecessorGroupStateRouteAuthSession('alice'),
      groupService: {},
      processGroupAppInbox: capturePredecessorGroupWrite(enqueued, {
        status: 'ok',
        result: Either.ofRight({ ...responseBody, event: null }),
      }),
    });
    const response = await postGroupStateMutationWithHeaders(
      app,
      `${API_BASE}/join-code/rotate`,
      {
        headers: AUTHENTICATED_HEADERS,
        body: {
          joinCode: 'code-1',
          expiresAtEpochMs: 2_000,
          requestId: 'group-route-rotate-code-1',
        },
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), responseBody);
    assert.deepEqual(enqueued, [
      {
        type: AppInboxType.GROUP_JOIN_CODE_ROTATE,
        topicId: AppInboxType.GROUP_JOIN_CODE_ROTATE,
        resourceId: 'group-route-rotate-code-1',
        contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
        senderId: 'alice',
        data: {
          scope: TEST_GROUP_SCOPE,
          groupId: 'room-1',
          request: {
            joinCode: 'code-1',
            expiresAtEpochMs: 2_000,
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            requestId: 'group-route-rotate-code-1',
          },
        },
      },
    ]);
  });
});

async function verifyGroupInviteRoutes(): Promise<void> {
  const snapshot = createPredecessorGroupStateRouteSnapshot('room-1', ['alice']);
  const enqueued: AuthenticatedGroupMutationEnqueue[] = [];
  const { app } = createPredecessorGroupStateRouteTestRuntime({
    session: createPredecessorGroupStateRouteAuthSession('alice'),
    groupService: {},
    processGroupAppInbox: capturePredecessorGroupWrite(enqueued, toGroupStateWritten(snapshot)),
  });
  const createResponse = await postGroupStateMutationWithHeaders(app, `${API_BASE}/invites/bob`, {
    headers: AUTHENTICATED_HEADERS,
    body: { invitationExpiresAtEpochMs: 2_000, requestId: 'group-route-invite-create-1' },
  });
  const revokeResponse = await postGroupStateMutationWithHeaders(
    app,
    `${API_BASE}/invites/bob/revoke`,
    { headers: AUTHENTICATED_HEADERS, body: { requestId: 'group-route-invite-revoke-1' } },
  );
  const acceptResponse = await postGroupStateMutationWithHeaders(
    app,
    `${API_BASE}/invites/accept`,
    { headers: AUTHENTICATED_HEADERS, body: { requestId: 'group-route-invite-accept-1' } },
  );

  assert.equal(createResponse.status, 200);
  assert.equal(revokeResponse.status, 200);
  assert.equal(acceptResponse.status, 200);
  assertGroupInviteEnvelopes(enqueued);
}

function assertGroupInviteEnvelopes(enqueued: AuthenticatedGroupMutationEnqueue[]): void {
  assert.deepEqual(enqueued, [
    {
      type: AppInboxType.GROUP_INVITE_CREATE,
      topicId: AppInboxType.GROUP_INVITE_CREATE,
      resourceId: 'group-route-invite-create-1',
      contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
      senderId: 'alice',
      data: {
        scope: TEST_GROUP_SCOPE,
        groupId: 'room-1',
        principalId: 'bob',
        request: {
          invitationExpiresAtEpochMs: 2_000,
          actorPrincipalId: 'alice',
          actorSessionId: 'alice-session',
          requestId: 'group-route-invite-create-1',
        },
      },
    },
    {
      type: AppInboxType.GROUP_INVITE_REVOKE,
      topicId: AppInboxType.GROUP_INVITE_REVOKE,
      resourceId: 'group-route-invite-revoke-1',
      contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
      senderId: 'alice',
      data: {
        scope: TEST_GROUP_SCOPE,
        groupId: 'room-1',
        principalId: 'bob',
        request: {
          actorPrincipalId: 'alice',
          actorSessionId: 'alice-session',
          requestId: 'group-route-invite-revoke-1',
        },
      },
    },
    {
      type: AppInboxType.GROUP_INVITE_ACCEPT,
      topicId: AppInboxType.GROUP_INVITE_ACCEPT,
      resourceId: 'group-route-invite-accept-1',
      contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
      senderId: 'alice',
      data: {
        scope: TEST_GROUP_SCOPE,
        groupId: 'room-1',
        request: {
          actorPrincipalId: 'alice',
          actorSessionId: 'alice-session',
          requestId: 'group-route-invite-accept-1',
        },
      },
    },
  ]);
}

function capturePredecessorGroupWrite(
  enqueued: AuthenticatedGroupMutationEnqueue[],
  durableResult: GroupStateInboxDurableResult,
): ProcessGroupAppInbox {
  return (_authority, input) => {
    enqueued.push(input);
    return Promise.resolve(durableResult);
  };
}
