import assert from 'node:assert/strict';

import type { AppInboxEnqueueInput } from '@shared-server/rallar-system/services/AppInboxService.ts';
import * as groupStateRoutes from '../../src/routes/group-state-routes.ts';

import {
  createGroupStateRouteSnapshot,
  createGroupStateRouteTestRuntime,
  toGroupStateWritten,
} from './group-state-route-test-runtime.ts';

const API_BASE = '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1';

Deno.test('group membership routes retain every AppInbox envelope and self-service omission', async () => {
  const enqueued: unknown[] = [];
  const snapshot = createGroupStateRouteSnapshot('room-1', ['alice', 'bob']);
  const runtime = createGroupStateRouteTestRuntime({
    processGroupAppInbox: captureGroupStateWrite(enqueued, snapshot),
  });

  const responses = [
    await requestGroupMutation(runtime.app, `${API_BASE}/members/bob/remove`, 'POST', {
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'remove-request',
    }),
    await requestGroupMutation(runtime.app, `${API_BASE}/members/bob/ban`, 'POST', {
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'ban-request',
    }),
    await requestGroupMutation(runtime.app, `${API_BASE}/members/bob/unban`, 'POST', {
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'unban-request',
    }),
    await requestGroupMutation(runtime.app, `${API_BASE}/members/bob/role`, 'PUT', {
      role: 'admin',
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'role-request',
    }),
    await requestGroupMutation(runtime.app, `${API_BASE}/owner/transfer`, 'POST', {
      newOwnerPrincipalId: 'bob',
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'transfer-request',
    }),
    await requestGroupMutation(runtime.app, `${API_BASE}/members/alice`, 'PUT', {
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

function captureGroupStateWrite(
  enqueued: unknown[],
  snapshot: ReturnType<typeof createGroupStateRouteSnapshot>,
): groupStateRoutes.ProcessGroupAppInbox {
  return <V, R>(
    _authority: groupStateRoutes.GroupStateRouteAuthSession,
    entry: AppInboxEnqueueInput<V>,
  ): Promise<R> => {
    enqueued.push(entry);
    return Promise.resolve(toGroupStateWritten(snapshot) as R);
  };
}

async function requestGroupMutation(
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
