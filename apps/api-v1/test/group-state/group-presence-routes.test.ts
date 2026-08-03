import assert from 'node:assert/strict';

import type { AppInboxEnqueueInput } from '@shared-server/rallar-system/services/AppInboxService.ts';
import * as groupStateRoutes from '../../src/routes/group-state-routes.ts';

import {
  createGroupStateRouteSnapshot,
  createGroupStateRouteTestRuntime,
} from './group-state-route-test-runtime.ts';

const API_BASE =
  '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/sessions/alice-session';

Deno.test('group presence routes retain every AppInbox envelope and post-receipt snapshot read', async () => {
  const enqueued: unknown[] = [];
  let currentSnapshotReads = 0;
  const snapshot = createGroupStateRouteSnapshot('room-1');
  const runtime = createGroupStateRouteTestRuntime({
    groupService: {
      readCurrentSnapshot: () => {
        currentSnapshotReads += 1;
        return Promise.resolve(snapshot);
      },
    },
    processGroupAppInbox: capturePresenceReceipt(enqueued),
  });

  const responses = [
    await requestPresenceMutation(runtime.app, API_BASE, 'PUT', {
      generationId: 'generation-connect',
      principalId: 'forged-principal',
      actorPrincipalId: 'forged-actor',
      connectedAtEpochMs: 1,
      lastHeartbeatAtEpochMs: 1,
      expiresAtEpochMs: 2,
      requestId: 'connect-request',
    }),
    await requestPresenceMutation(runtime.app, `${API_BASE}/heartbeat`, 'POST', {
      generationId: 'generation-heartbeat',
      principalId: 'forged-principal',
      lastHeartbeatAtEpochMs: 2,
      expiresAtEpochMs: 3,
      requestId: 'heartbeat-request',
    }),
    await requestPresenceMutation(runtime.app, `${API_BASE}/disconnect`, 'POST', {
      generationId: 'generation-disconnect',
      principalId: 'forged-principal',
      lastHeartbeatAtEpochMs: 3,
      disconnectedAtEpochMs: 4,
      expiresAtEpochMs: 5,
      requestId: 'disconnect-request',
    }),
  ];

  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), snapshot);
  }
  assert.equal(currentSnapshotReads, 3);
  assert.equal(
    JSON.stringify(enqueued),
    '[{"type":"GROUP_PRESENCE_CONNECT","resourceId":"connect-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","sessionId":"alice-session","request":{"generationId":"generation-connect","principalId":"alice","actorPrincipalId":"alice","connectedAtEpochMs":1,"lastHeartbeatAtEpochMs":1,"expiresAtEpochMs":2,"requestId":"connect-request","actorSessionId":"alice-session"}}},{"type":"GROUP_PRESENCE_HEARTBEAT","resourceId":"heartbeat-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","sessionId":"alice-session","request":{"generationId":"generation-heartbeat","principalId":"alice","lastHeartbeatAtEpochMs":2,"expiresAtEpochMs":3,"requestId":"heartbeat-request","actorPrincipalId":"alice","actorSessionId":"alice-session"}}},{"type":"GROUP_PRESENCE_DISCONNECT","resourceId":"disconnect-request","contextId":"app-1:workspace-1:room-1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-1","sessionId":"alice-session","request":{"generationId":"generation-disconnect","principalId":"alice","lastHeartbeatAtEpochMs":3,"disconnectedAtEpochMs":4,"expiresAtEpochMs":5,"requestId":"disconnect-request","actorPrincipalId":"alice","actorSessionId":"alice-session"}}}]',
  );
});

Deno.test('group presence route rejects a receipt before its cleanup read', async () => {
  let currentSnapshotReads = 0;
  const runtime = createGroupStateRouteTestRuntime({
    groupService: {
      readCurrentSnapshot: () => {
        currentSnapshotReads += 1;
        return Promise.resolve(createGroupStateRouteSnapshot('room-1'));
      },
    },
    processGroupAppInbox: () =>
      Promise.resolve({
        outcome: 'rejected',
        rejection: 'Presence rejected by current authority',
      } as never),
  });

  const response = await requestPresenceMutation(runtime.app, API_BASE, 'PUT', {
    generationId: 'generation-1',
    connectedAtEpochMs: 1,
    lastHeartbeatAtEpochMs: 1,
    expiresAtEpochMs: 2,
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Presence rejected by current authority' });
  assert.equal(currentSnapshotReads, 0);
});

function capturePresenceReceipt(enqueued: unknown[]): groupStateRoutes.ProcessGroupAppInbox {
  return <V, R>(
    _authority: groupStateRoutes.GroupStateRouteAuthSession,
    entry: AppInboxEnqueueInput<V>,
  ): Promise<R> => {
    enqueued.push(entry);
    return Promise.resolve({
      outcome: 'applied',
      causalRevision: { groupRevision: 1, presenceRevision: 1 },
    } as R);
  };
}

async function requestPresenceMutation(
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
