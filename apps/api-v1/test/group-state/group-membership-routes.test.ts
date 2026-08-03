import assert from 'node:assert/strict';

import {
  type AppInboxEnqueueInput,
  AppInboxType,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import { toGroupStateCommand } from '../../src/group-state/to-group-state-command.ts';
import type { GroupStateRouteAuthSession } from '../../src/group-state/group-state-route-contracts.ts';

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
  putGroupStateMutation,
  TEST_GROUP_SCOPE,
  withStrictGroupStateRouteReadAuth,
} from './group-state-route-test-runtime.ts';

const API_BASE = '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1';

Deno.test('group membership commands retain governance and self-service envelopes', () => {
  const authSession = createGroupStateRouteAuthSession('alice');
  const commands = [
    toGroupStateCommand({
      operation: 'remove-group-member',
      authSession,
      scope: TEST_GROUP_SCOPE,
      groupId: 'room-1',
      principalId: 'bob',
      request: {
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
        requestId: 'remove-request',
      },
    }),
    toGroupStateCommand({
      operation: 'ban-group-member',
      authSession,
      scope: TEST_GROUP_SCOPE,
      groupId: 'room-1',
      principalId: 'bob',
      request: {
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
        requestId: 'ban-request',
      },
    }),
    toGroupStateCommand({
      operation: 'unban-group-member',
      authSession,
      scope: TEST_GROUP_SCOPE,
      groupId: 'room-1',
      principalId: 'bob',
      request: {
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
        requestId: 'unban-request',
      },
    }),
    toGroupStateCommand({
      operation: 'set-group-member-role',
      authSession,
      scope: TEST_GROUP_SCOPE,
      groupId: 'room-1',
      principalId: 'bob',
      request: {
        role: 'admin',
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
        requestId: 'role-request',
      },
    }),
    toGroupStateCommand({
      operation: 'transfer-group-ownership',
      authSession,
      scope: TEST_GROUP_SCOPE,
      groupId: 'room-1',
      request: {
        newOwnerPrincipalId: 'bob',
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
        requestId: 'transfer-request',
      },
    }),
    toGroupStateCommand({
      operation: 'upsert-group-member',
      authSession,
      scope: TEST_GROUP_SCOPE,
      groupId: 'room-1',
      principalId: 'alice',
      request: {
        status: 'active',
        role: 'admin',
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
        requestId: 'upsert-request',
      },
    }),
  ];

  assert.equal(
    JSON.stringify(commands),
    '[{"type":"GROUP_MEMBER_REMOVE","resourceId":"remove-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","principalId":"bob","request":{"actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"remove-request"}}},{"type":"GROUP_MEMBER_BAN","resourceId":"ban-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","principalId":"bob","request":{"actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"ban-request"}}},{"type":"GROUP_MEMBER_UNBAN","resourceId":"unban-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","principalId":"bob","request":{"actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"unban-request"}}},{"type":"GROUP_MEMBER_ROLE_SET","resourceId":"role-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","principalId":"bob","request":{"role":"admin","actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"role-request"}}},{"type":"GROUP_OWNERSHIP_TRANSFER","resourceId":"transfer-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","request":{"newOwnerPrincipalId":"bob","actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"transfer-request"}}},{"type":"GROUP_MEMBER_UPSERT","resourceId":"upsert-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","principalId":"alice","request":{"status":"active","actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"upsert-request"}}}]',
  );
});

Deno.test('group membership routes retain every AppInbox envelope and self-service omission', async () => {
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
});

Deno.test('group governance routes enqueue safe workflows with authenticated actors', async () => {
  await withStrictGroupStateRouteReadAuth(false, async () => {
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
        return Promise.resolve({
          status: 'ok',
          result: {
            right: { snapshot },
          },
        } as R);
      },
    });

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
  });
});
