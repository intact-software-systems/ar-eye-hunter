import assert from 'node:assert/strict';

import {
  type AppInboxEnqueueInput,
  AppInboxType,
} from '@shared-server/rallar-system/services/AppInboxService.ts';

import { toGroupStateCommand } from '../../src/group-state/to-group-state-command.ts';
import type {
  GroupStateRouteAuthSession,
} from '../../src/group-state/group-state-route-contracts.ts';

import {
  captureGroupStateRouteWrite,
  createGroupStateRouteAuthSession,
  createGroupStateRouteSnapshot,
  createGroupStateRouteTestDependencies,
  createGroupStateRouteTestRuntime,
  createPredecessorGroupStateRouteAuthSession,
  createPredecessorGroupStateRouteSnapshot,
  createPredecessorGroupStateRouteTestRuntime,
  postGroupStateMutation,
  postGroupStateMutationWithHeaders,
  putGroupStateMutation,
  TEST_GROUP_SCOPE,
  withStrictGroupStateRouteReadAuth,
} from './group-state-route-test-runtime.ts';

const API_BASE = '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1';
const AUTHENTICATED_HEADERS = { authorization: 'Bearer token' } as const;

Deno.test('group membership commands retain governance and self-service envelopes', () => {
  const authSession = createGroupStateRouteAuthSession('alice');
  const commandBase = { authSession, scope: TEST_GROUP_SCOPE, groupId: 'room-1' } as const;
  const forgedActor = { actorPrincipalId: 'forged-actor', actorSessionId: 'forged-session' };
  const commands = [
    ...createMemberRestrictionCommands(authSession),
    toGroupStateCommand({
      operation: 'set-group-member-role',
      ...commandBase,
      principalId: 'bob',
      request: {
        role: 'admin',
        ...forgedActor,
        requestId: 'role-request',
      },
    }),
    toGroupStateCommand({
      operation: 'transfer-group-ownership',
      ...commandBase,
      request: {
        newOwnerPrincipalId: 'bob',
        ...forgedActor,
        requestId: 'transfer-request',
      },
    }),
    toGroupStateCommand({
      operation: 'upsert-group-member',
      ...commandBase,
      principalId: 'alice',
      request: {
        status: 'active',
        role: 'admin',
        ...forgedActor,
        requestId: 'upsert-request',
      },
    }),
  ];

  assert.equal(
    JSON.stringify(commands),
    '[{"type":"GROUP_MEMBER_REMOVE","resourceId":"remove-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","principalId":"bob","request":{"actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"remove-request"}}},{"type":"GROUP_MEMBER_BAN","resourceId":"ban-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","principalId":"bob","request":{"actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"ban-request"}}},{"type":"GROUP_MEMBER_UNBAN","resourceId":"unban-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","principalId":"bob","request":{"actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"unban-request"}}},{"type":"GROUP_MEMBER_ROLE_SET","resourceId":"role-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","principalId":"bob","request":{"role":"admin","actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"role-request"}}},{"type":"GROUP_OWNERSHIP_TRANSFER","resourceId":"transfer-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","request":{"newOwnerPrincipalId":"bob","actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"transfer-request"}}},{"type":"GROUP_MEMBER_UPSERT","resourceId":"upsert-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","principalId":"alice","request":{"status":"active","actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"upsert-request"}}}]',
  );
});

Deno.test(
  'group membership routes retain every AppInbox envelope and self-service omission',
  async () => {
    const enqueued: unknown[] = [];
    const snapshot = createGroupStateRouteSnapshot('room-1', ['alice', 'bob']);
    const runtime = createGroupStateRouteTestRuntime({
      processGroupAppInbox: captureGroupStateRouteWrite(enqueued, snapshot),
    });

    const responses = [
      await postGroupStateMutation(runtime.app, `${API_BASE}/members/bob/remove`, {
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
        requestId: 'remove-request',
      }),
      await postGroupStateMutation(runtime.app, `${API_BASE}/members/bob/ban`, {
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
        requestId: 'ban-request',
      }),
      await postGroupStateMutation(runtime.app, `${API_BASE}/members/bob/unban`, {
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
        requestId: 'unban-request',
      }),
      await putGroupStateMutation(runtime.app, `${API_BASE}/members/bob/role`, {
        role: 'admin',
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
        requestId: 'role-request',
      }),
      await postGroupStateMutation(runtime.app, `${API_BASE}/owner/transfer`, {
        newOwnerPrincipalId: 'bob',
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
        requestId: 'transfer-request',
      }),
      await putGroupStateMutation(runtime.app, `${API_BASE}/members/alice`, {
        status: 'active',
        role: 'admin',
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
        requestId: 'upsert-request',
      }),
    ];

    for (const response of responses) {
      assert.equal(response.status, 200);
    }
    assert.equal(
      JSON.stringify(enqueued),
      '[{"type":"GROUP_MEMBER_REMOVE","resourceId":"remove-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","principalId":"bob","request":{"actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"remove-request"}}},{"type":"GROUP_MEMBER_BAN","resourceId":"ban-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","principalId":"bob","request":{"actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"ban-request"}}},{"type":"GROUP_MEMBER_UNBAN","resourceId":"unban-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","principalId":"bob","request":{"actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"unban-request"}}},{"type":"GROUP_MEMBER_ROLE_SET","resourceId":"role-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","principalId":"bob","request":{"role":"admin","actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"role-request"}}},{"type":"GROUP_OWNERSHIP_TRANSFER","resourceId":"transfer-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","request":{"newOwnerPrincipalId":"bob","actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"transfer-request"}}},{"type":"GROUP_MEMBER_UPSERT","resourceId":"upsert-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","principalId":"alice","request":{"status":"active","actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"upsert-request"}}}]',
    );
  },
);

Deno.test(
  'group governance routes enqueue safe workflows with authenticated actors',
  () => withStrictGroupStateRouteReadAuth(false, verifyGroupGovernanceRoutes),
);

async function verifyGroupGovernanceRoutes(): Promise<void> {
  const snapshot = createPredecessorGroupStateRouteSnapshot('room-1', ['alice', 'bob']);
  const enqueued: AppInboxEnqueueInput<unknown>[] = [];
  const { app } = createPredecessorGroupStateRouteTestRuntime({
    session: createPredecessorGroupStateRouteAuthSession('alice'),
    groupService: {},
    processGroupAppInbox: <V, R>(
      _authority: GroupStateRouteAuthSession,
      input: AppInboxEnqueueInput<V>,
    ): Promise<R> => {
      enqueued.push(input);
      return Promise.resolve({ status: 'ok', result: { right: { snapshot } } } as R);
    },
  });
  const responses = await requestGovernanceRoutes(app);

  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), snapshot);
  }
  assertMemberRestrictionEnvelopes(enqueued.slice(0, 3));
  assertRoleAndOwnershipEnvelopes(enqueued.slice(3));
}

async function requestGovernanceRoutes(
  app: ReturnType<typeof createPredecessorGroupStateRouteTestRuntime>['app'],
): Promise<Response[]> {
  return await Promise.all([
    postGroupStateMutationWithHeaders(app, `${API_BASE}/members/bob/remove`, {
      headers: AUTHENTICATED_HEADERS,
      body: { requestId: 'remove-bob' },
    }),
    postGroupStateMutationWithHeaders(app, `${API_BASE}/members/bob/ban`, {
      headers: AUTHENTICATED_HEADERS,
      body: { requestId: 'ban-bob' },
    }),
    postGroupStateMutationWithHeaders(app, `${API_BASE}/members/bob/unban`, {
      headers: AUTHENTICATED_HEADERS,
      body: { requestId: 'unban-bob' },
    }),
    app.request(`${API_BASE}/members/bob/role`, {
      method: 'PUT',
      headers: { ...AUTHENTICATED_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'admin', requestId: 'role-bob' }),
    }),
    postGroupStateMutationWithHeaders(app, `${API_BASE}/owner/transfer`, {
      headers: AUTHENTICATED_HEADERS,
      body: { newOwnerPrincipalId: 'bob', requestId: 'transfer-owner' },
    }),
  ]);
}

function assertMemberRestrictionEnvelopes(enqueued: AppInboxEnqueueInput<unknown>[]): void {
  assert.deepEqual(enqueued, [
    {
      type: AppInboxType.GROUP_MEMBER_REMOVE,
      resourceId: 'remove-bob',
      contextId: 'app-1:workspace-1:room-1',
      senderId: 'alice',
      data: {
        scope: TEST_GROUP_SCOPE,
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
        scope: TEST_GROUP_SCOPE,
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
        scope: TEST_GROUP_SCOPE,
        groupId: 'room-1',
        principalId: 'bob',
        request: {
          actorPrincipalId: 'alice',
          actorSessionId: 'alice-session',
          requestId: 'unban-bob',
        },
      },
    },
  ]);
}

function assertRoleAndOwnershipEnvelopes(enqueued: AppInboxEnqueueInput<unknown>[]): void {
  assert.deepEqual(enqueued, [
    {
      type: AppInboxType.GROUP_MEMBER_ROLE_SET,
      resourceId: 'role-bob',
      contextId: 'app-1:workspace-1:room-1',
      senderId: 'alice',
      data: {
        scope: TEST_GROUP_SCOPE,
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
        scope: TEST_GROUP_SCOPE,
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
}

function createMemberRestrictionCommands(
  authSession: GroupStateRouteAuthSession,
): readonly ReturnType<typeof toGroupStateCommand>[] {
  const commandBase = { authSession, scope: TEST_GROUP_SCOPE, groupId: 'room-1' } as const;
  const forgedActor = { actorPrincipalId: 'forged-actor', actorSessionId: 'forged-session' };
  return [
    toGroupStateCommand({
      operation: 'remove-group-member',
      ...commandBase,
      principalId: 'bob',
      request: { ...forgedActor, requestId: 'remove-request' },
    }),
    toGroupStateCommand({
      operation: 'ban-group-member',
      ...commandBase,
      principalId: 'bob',
      request: { ...forgedActor, requestId: 'ban-request' },
    }),
    toGroupStateCommand({
      operation: 'unban-group-member',
      ...commandBase,
      principalId: 'bob',
      request: { ...forgedActor, requestId: 'unban-request' },
    }),
  ];
}
