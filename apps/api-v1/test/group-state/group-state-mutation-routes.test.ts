import assert from 'node:assert/strict';

import type {
  AppInboxEnqueueInput,
} from '@shared-server/rallar-system/services/AppInboxService.ts';

import {
  readGroupStateRouteRequest,
} from '../../src/group-state/read-group-state-route-request.ts';
import * as groupStateRoutes from '../../src/routes/group-state-routes.ts';

import {
  createGroupStateRouteSnapshot,
  createGroupStateRouteTestRuntime,
  toGroupStateWritten,
} from './group-state-route-test-runtime.ts';

const API_BASE = '/api/state/apps/app-1/workspaces/workspace-1/groups';
const RANDOM_UUID_DESCRIPTOR_AT_MODULE_LOAD = Object.getOwnPropertyDescriptor(
  crypto,
  'randomUUID',
);
const RANDOM_UUID_AT_MODULE_LOAD = crypto.randomUUID;

Deno.test('canonical group request reader retains body request ID precedence', async () => {
  const request = await readGroupStateRouteRequest<{ requestId?: string; name: string }>({
    req: {
      json: () => Promise.resolve({ requestId: 'body-request', name: 'Room' }),
      header: () => 'header-request',
    },
  });

  assert.deepEqual(request, { requestId: 'body-request', name: 'Room' });
});

Deno.test('group aggregate routes retain their AppInbox envelopes', async () => {
  const enqueued: unknown[] = [];
  const snapshot = createGroupStateRouteSnapshot('room-1');
  const runtime = createGroupStateRouteTestRuntime({
    groupService: { readSnapshot: () => Promise.resolve(snapshot) },
    processGroupAppInbox: captureGroupStateWrite(enqueued, snapshot),
  });

  const responses = [
    await requestGroupMutation(runtime.app, API_BASE, 'POST', {
      groupId: 'room/1',
      displayName: 'Room',
      kind: 'room',
      createdByPrincipalId: 'forged-creator',
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'create-body',
    }),
    await requestGroupMutation(runtime.app, `${API_BASE}/room-2`, 'PUT', {
      displayName: 'Renamed',
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'update-body',
    }),
    await requestGroupMutation(runtime.app, `${API_BASE}/room-3/director/appoint`, 'POST', {
      heartbeatTtlMs: 20,
      actorPrincipalId: 'forged-actor',
      actorSessionId: 'forged-session',
      requestId: 'appoint-body',
    }),
  ];

  assert.equal(responses[0].status, 201);
  assert.equal(responses[1].status, 200);
  assert.equal(responses[2].status, 200);
  assert.equal(
    JSON.stringify(enqueued),
    '[{"type":"GROUP_CREATE","resourceId":"create-body","contextId":"app-1:workspace-1:room%2F1","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"request":{"groupId":"room/1","displayName":"Room","kind":"room","createdByPrincipalId":"alice","actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"create-body"}}},{"type":"GROUP_UPDATE","resourceId":"update-body","contextId":"app-1:workspace-1:room-2","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-2","request":{"displayName":"Renamed","actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"update-body"}}},{"type":"GROUP_DIRECTOR_APPOINT","resourceId":"appoint-body","contextId":"app-1:workspace-1:room-3","senderId":"alice","data":{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"groupId":"room-3","request":{"heartbeatTtlMs":20,"actorPrincipalId":"alice","actorSessionId":"alice-session","requestId":"appoint-body"}}}]',
  );
});

Deno.test(
  'group aggregate routes preserve body, header, then one generated request ID',
  async () => {
    const enqueued: unknown[] = [];
    const snapshot = createGroupStateRouteSnapshot('room-1');
    const runtime = createGroupStateRouteTestRuntime({
      processGroupAppInbox: captureGroupStateWrite(enqueued, snapshot),
    });

    await withRandomUuid('generated-request', async (readRandomCallCount) => {
      const bodyResponse = await requestGroupMutation(runtime.app, API_BASE, 'POST', {
        groupId: 'body-id-group',
        displayName: 'Body',
        kind: 'room',
        requestId: 'body-request',
      }, { 'Idempotency-Key': 'header-request' });
      const headerResponse = await requestGroupMutation(runtime.app, API_BASE, 'POST', {
        groupId: 'header-id-group',
        displayName: 'Header',
        kind: 'room',
      }, { 'Idempotency-Key': 'header-request' });
      const generatedResponse = await requestGroupMutation(runtime.app, API_BASE, 'POST', {
        groupId: 'generated-id-group',
        displayName: 'Generated',
        kind: 'room',
      });

      assert.equal(bodyResponse.status, 201);
      assert.equal(headerResponse.status, 201);
      assert.equal(generatedResponse.status, 201);
      assert.equal(readRandomCallCount(), 1);
    });

    assert.equal(
      JSON.stringify(enqueued.map((entry) => {
        const envelope = entry as AppInboxEnqueueInput<unknown>;
        return [envelope.resourceId, envelope.data];
      })),
      '[["body-request",{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"request":{"groupId":"body-id-group","displayName":"Body","kind":"room","requestId":"body-request","createdByPrincipalId":"alice","actorPrincipalId":"alice","actorSessionId":"alice-session"}}],["header-request",{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"request":{"groupId":"header-id-group","displayName":"Header","kind":"room","requestId":"header-request","createdByPrincipalId":"alice","actorPrincipalId":"alice","actorSessionId":"alice-session"}}],["generated-request",{"scope":{"applicationId":"app-1","workspaceId":"workspace-1"},"request":{"groupId":"generated-id-group","displayName":"Generated","kind":"room","requestId":"generated-request","createdByPrincipalId":"alice","actorPrincipalId":"alice","actorSessionId":"alice-session"}}]]',
    );
  },
);

Deno.test(
  'group aggregate request ID UUID stub restores crypto randomUUID observable shape',
  () => {
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(crypto, 'randomUUID'),
      RANDOM_UUID_DESCRIPTOR_AT_MODULE_LOAD,
    );
    assert.equal(crypto.randomUUID, RANDOM_UUID_AT_MODULE_LOAD);
    assert.notEqual(crypto.randomUUID(), 'generated-request');
  },
);

Deno.test(
  'group aggregate route waits for AppInbox completion before its normal response',
  async () => {
    let resolveCompletion: (() => void) | undefined;
    let enqueued = 0;
    const snapshot = createGroupStateRouteSnapshot('room-1');
    const runtime = createGroupStateRouteTestRuntime({
      processGroupAppInbox: <V, R>(
        _authority: groupStateRoutes.GroupStateRouteAuthSession,
        _entry: AppInboxEnqueueInput<V>,
      ): Promise<R> =>
        new Promise((resolve) => {
          enqueued += 1;
          resolveCompletion = () => resolve(toGroupStateWritten(snapshot) as R);
        }),
    });

    const responsePromise = requestGroupMutation(runtime.app, API_BASE, 'POST', {
      groupId: 'room-1',
      displayName: 'Room',
      kind: 'room',
      requestId: 'await-completion',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(enqueued, 1);
    assert.ok(resolveCompletion);
    resolveCompletion();

    const response = await responsePromise;
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), snapshot);
  },
);

Deno.test(
  'group aggregate route stops at route authentication failure before AppInbox',
  async () => {
    let enqueued = 0;
    const runtime = createGroupStateRouteTestRuntime({
      installStateAuthentication: false,
      requireApiAuthSession: () => Promise.reject(new Error('route authentication failed')),
      processGroupAppInbox: () => {
        enqueued += 1;
        return Promise.resolve(undefined as never);
      },
    });

    const response = await requestGroupMutation(runtime.app, API_BASE, 'POST', {
      groupId: 'room-1',
      displayName: 'Room',
      kind: 'room',
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'route authentication failed' });
    assert.equal(enqueued, 0);
  },
);

Deno.test(
  'group aggregate route serializes AppInbox failure after the awaited completion',
  async () => {
    const failure = Object.assign(new Error('group command rejected'), {
      code: 'group-command-rejected',
      status: 409,
      details: { groupId: 'room-1' },
    });
    const runtime = createGroupStateRouteTestRuntime({
      processGroupAppInbox: () => Promise.reject(failure),
    });

    const response = await requestGroupMutation(runtime.app, API_BASE, 'POST', {
      groupId: 'room-1',
      displayName: 'Room',
      kind: 'room',
    });

    assert.equal(response.status, 409);
    assert.equal(
      JSON.stringify(await response.json()),
      '{"error":"group command rejected","code":"group-command-rejected"}',
    );
  },
);

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
  headers: Record<string, string> = {},
): Promise<Response> {
  return await app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function withRandomUuid(
  value: string,
  action: (readCallCount: () => number) => Promise<void>,
): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  let callCount = 0;
  Object.defineProperty(crypto, 'randomUUID', {
    configurable: true,
    value: () => {
      callCount += 1;
      return value;
    },
  });
  try {
    await action(() => callCount);
  } finally {
    if (descriptor) {
      Object.defineProperty(crypto, 'randomUUID', descriptor);
    } else {
      Reflect.deleteProperty(crypto, 'randomUUID');
    }
  }
}
