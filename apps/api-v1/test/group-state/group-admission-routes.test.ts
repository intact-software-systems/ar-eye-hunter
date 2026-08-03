import assert from 'node:assert/strict';

import { Either } from '@shared/resilience/Either.ts';
import type { AppInboxEnqueueInput } from '@shared-server/rallar-system/services/AppInboxService.ts';
import { toGroupStateCommand } from '../../src/group-state/to-group-state-command.ts';
import { toGroupStateResponse } from '../../src/group-state/to-group-state-response.ts';
import * as groupStateRoutes from '../../src/routes/group-state-routes.ts';

import {
  createGroupStateRouteAuthSession,
  createGroupStateRouteEvent,
  createGroupStateRouteSnapshot,
  createGroupStateRouteTestRuntime,
  TEST_GROUP_SCOPE,
  toGroupStateWritten,
} from './group-state-route-test-runtime.ts';

const API_BASE = '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1';

Deno.test('group admission commands retain every authenticated AppInbox envelope', () => {
  const authSession = createGroupStateRouteAuthSession('alice');
  const commands = [
    toGroupStateCommand({
      operation: 'join-group',
      authSession,
      scope: TEST_GROUP_SCOPE,
      groupId: 'room-1',
      request: {
        inviteToken: 'invite-1',
        joinCode: 'code-1',
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
        requestId: 'join-request',
      },
    }),
    toGroupStateCommand({
      operation: 'accept-group-invite',
      authSession,
      scope: TEST_GROUP_SCOPE,
      groupId: 'room-1',
      request: {
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
        requestId: 'accept-request',
      },
    }),
    toGroupStateCommand({
      operation: 'rotate-group-join-code',
      authSession,
      scope: TEST_GROUP_SCOPE,
      groupId: 'room-1',
      request: {
        joinCode: 'next-code',
        expiresAtEpochMs: 2000,
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
        requestId: 'rotate-request',
      },
    }),
    toGroupStateCommand({
      operation: 'create-group-invite',
      authSession,
      scope: TEST_GROUP_SCOPE,
      groupId: 'room-1',
      principalId: 'bob',
      request: {
        invitationExpiresAtEpochMs: 2000,
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
        requestId: 'invite-request',
      },
    }),
    toGroupStateCommand({
      operation: 'revoke-group-invite',
      authSession,
      scope: TEST_GROUP_SCOPE,
      groupId: 'room-1',
      principalId: 'bob',
      request: {
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
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
    '{"joinCode":"next-code","expiresAtEpochMs":2000,"snapshot":{"stateRevision":1,"causalRevision":{"groupRevision":1,"presenceRevision":0},"group":{"applicationId":"app-1","workspaceId":"workspace-1","groupId":"room-1","slug":null,"displayName":"room-1","description":null,"kind":"room","status":"active","joinMode":"open","maxMembers":null,"maxSessionsPerMember":null,"metadata":{},"activeMemberCount":1,"ownerPrincipalId":"alice","snapshotVersion":1,"metadataVersion":1,"rosterVersion":1,"presenceVersion":0,"created":{"atEpochMs":1,"actor":{"kind":"service","serviceId":"test"},"reason":null,"traceId":null,"requestId":null},"updated":{"atEpochMs":1,"actor":{"kind":"service","serviceId":"test"},"reason":null,"traceId":null,"requestId":null},"expiresAtEpochMs":null,"emptySinceEpochMs":null,"purgeAfterEpochMs":null,"archived":null,"deleted":null},"members":[{"applicationId":"app-1","workspaceId":"workspace-1","groupId":"room-1","principalId":"alice","role":"owner","status":"active","joined":{"atEpochMs":1,"actor":{"kind":"service","serviceId":"test"},"reason":null,"traceId":null,"requestId":null},"updated":{"atEpochMs":1,"actor":{"kind":"service","serviceId":"test"},"reason":null,"traceId":null,"requestId":null},"left":null,"removed":null,"banned":null,"invitedByPrincipalId":null,"invitationExpiresAtEpochMs":null}],"activeSessions":[],"memberCount":1,"onlineMemberCount":0}}',
  );
});

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
