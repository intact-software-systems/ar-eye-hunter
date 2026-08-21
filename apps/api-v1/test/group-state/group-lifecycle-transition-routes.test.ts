import assert from 'node:assert/strict';


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
      requestId: 'group-route-start-body',
    }),
    await postGroupStateMutation(runtime.app, `${API_BASE}/room-1/lifecycle/activate`, {
      requestId: 'group-route-activate-body',
    }),
    await postGroupStateMutation(runtime.app, `${API_BASE}/room-1/lifecycle/reopen`, {
      reason: 'topology-refresh',
      requestId: 'group-route-reopen-body',
    }),
  ];
  for (const response of responses) {
    assert.equal(response.status, 200);
  }
  assert.deepEqual(
    enqueued.map((enqueue) => ({
      type: enqueue.type,
      topicId: enqueue.topicId,
      resourceId: enqueue.resourceId,
      contextId: enqueue.contextId,
      request: enqueue.data.request,
    })),
    [
      {
        type: 'GROUP_ESTABLISHMENT_START',
        topicId: 'GROUP_ESTABLISHMENT_START',
        resourceId: 'group-route-start-body',
        contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
        request: {
          actorPrincipalId: 'alice',
          actorSessionId: 'alice-session',
          requestId: 'group-route-start-body',
        },
      },
      {
        type: 'GROUP_ACTIVATE',
        topicId: 'GROUP_ACTIVATE',
        resourceId: 'group-route-activate-body',
        contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
        request: {
          actorPrincipalId: 'alice',
          actorSessionId: 'alice-session',
          requestId: 'group-route-activate-body',
        },
      },
      {
        type: 'GROUP_ESTABLISHMENT_REOPEN',
        topicId: 'GROUP_ESTABLISHMENT_REOPEN',
        resourceId: 'group-route-reopen-body',
        contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
        request: {
          reason: 'topology-refresh',
          actorPrincipalId: 'alice',
          actorSessionId: 'alice-session',
          requestId: 'group-route-reopen-body',
        },
      },
    ],
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
