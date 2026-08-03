import assert from 'node:assert/strict';

import type { AppInboxEnqueueInput } from '@shared-server/rallar-system/services/AppInboxService.ts';
import * as groupStateRoutes from '../../src/routes/group-state-routes.ts';

import {
  createGroupStateRouteSnapshot,
  createGroupStateRouteTestRuntime,
  toGroupStateWritten,
} from './group-state-route-test-runtime.ts';

const API_BASE = '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1';

Deno.test('group admission routes retain every AppInbox envelope and actor override', async () => {
  const enqueued: unknown[] = [];
  const snapshot = createGroupStateRouteSnapshot('room-1');
  const runtime = createGroupStateRouteTestRuntime({
    processGroupAppInbox: captureGroupStateWrite(enqueued, snapshot),
  });

  const responses = [
    await requestGroupMutation(runtime.app, `${API_BASE}/join`, {
      inviteToken: 'invite-1',
      joinCode: 'code-1',
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'join-request',
    }),
    await requestGroupMutation(runtime.app, `${API_BASE}/invites/accept`, {
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'accept-request',
    }),
    await requestGroupMutation(runtime.app, `${API_BASE}/join-code/rotate`, {
      joinCode: 'next-code',
      expiresAtEpochMs: 2000,
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'rotate-request',
    }),
    await requestGroupMutation(runtime.app, `${API_BASE}/invites/bob`, {
      invitationExpiresAtEpochMs: 2000,
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'invite-request',
    }),
    await requestGroupMutation(runtime.app, `${API_BASE}/invites/bob/revoke`, {
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
  body: Record<string, unknown>,
): Promise<Response> {
  return await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
