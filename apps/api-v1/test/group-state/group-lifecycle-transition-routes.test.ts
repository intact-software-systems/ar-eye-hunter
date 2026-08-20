import assert from 'node:assert/strict';

// prettier-ignore
import type {
  AuthenticatedGroupMutationEnqueue,
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';

import {
  captureGroupStateRouteWrite,
  createGroupStateRouteSnapshot,
  createGroupStateRouteTestRuntime,
  postGroupStateMutation,
} from './group-state-route-test-runtime.ts';

const API_BASE = '/api/state/apps/app-1/workspaces/workspace-1/groups';

Deno.test('group lifecycle transition routes retain their AppInbox envelopes', async () => {
  const enqueued: AuthenticatedGroupMutationEnqueue[] = [];
  const snapshot = createGroupStateRouteSnapshot('room-1');
  const runtime = createGroupStateRouteTestRuntime({
    processGroupAppInbox: captureGroupStateRouteWrite(enqueued, snapshot),
  });
  const responses = [
    await postGroupStateMutation(runtime.app, `${API_BASE}/room-1/lifecycle/establish`, {
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'start-body',
    }),
    await postGroupStateMutation(runtime.app, `${API_BASE}/room-1/lifecycle/activate`, {
      requestId: 'activate-body',
    }),
    await postGroupStateMutation(runtime.app, `${API_BASE}/room-1/lifecycle/reopen`, {
      reason: 'topology-refresh',
      requestId: 'reopen-body',
    }),
  ];
  for (const response of responses) assert.equal(response.status, 200);
  assert.equal(
    JSON.stringify(enqueued),
    '[{"type":"GROUP_ESTABLISHMENT_START","resourceId":"start-body",' +
      '"contextId":"app-1:workspace-1:room-1","senderId":"alice",' +
      '"data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},' +
      '"groupId":"room-1","request":{"actorPrincipalId":"alice",' +
      '"actorSessionId":"alice-session","requestId":"start-body"}}},' +
      '{"type":"GROUP_ACTIVATE","resourceId":"activate-body",' +
      '"contextId":"app-1:workspace-1:room-1","senderId":"alice",' +
      '"data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},' +
      '"groupId":"room-1","request":{"requestId":"activate-body",' +
      '"actorPrincipalId":"alice","actorSessionId":"alice-session"}}},' +
      '{"type":"GROUP_ESTABLISHMENT_REOPEN","resourceId":"reopen-body",' +
      '"contextId":"app-1:workspace-1:room-1","senderId":"alice",' +
      '"data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},' +
      '"groupId":"room-1","request":{"reason":"topology-refresh",' +
      '"requestId":"reopen-body","actorPrincipalId":"alice",' +
      '"actorSessionId":"alice-session"}}}]',
  );
});

Deno.test('group lifecycle transition routes reject malformed actor fields', async () => {
  const runtime = createGroupStateRouteTestRuntime({
    processGroupAppInbox: () => Promise.reject(new Error('must not enqueue')),
  });
  const response = await postGroupStateMutation(
    runtime.app,
    `${API_BASE}/room-1/lifecycle/activate`,
    { traceId: 7 },
  );
  assert.equal(response.status, 400);
});
