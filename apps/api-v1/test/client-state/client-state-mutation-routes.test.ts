import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';

import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { AppInboxEnqueueInput } from '@shared-server/rallar-system/services/AppInboxService.ts';

import * as clientStateRoutes from '../../src/routes/client-state-routes.ts';

import {
  createAuthSession,
  createClientRouteApp,
  createClientRouteDeps,
  createClientSnapshot,
  TEST_SCOPE,
  toClientStateWritten,
} from './client-state-route-test-runtime.ts';

const REQUEST_ID = 'ClientMutationRequest_012345';

Deno.test('malformed client REST mutations return terminal 400 before inbox enqueue', async () => {
  const processCalls: unknown[] = [];
  const deps = createClientRouteDeps({
    session: createAuthSession('alice'),
    clientService: {},
    processClientAppInbox: (input) => {
      processCalls.push(input);
      return Promise.resolve(toClientStateWritten(createClientSnapshot('alice')));
    },
  });
  const app = createClientRouteApp(deps);
  const base = '/api/state/apps/app-1/workspaces/workspace-1/clients/alice';
  const cases = [
    {
      method: 'PUT',
      path: `${base}/principal`,
      body: { username: '', status: 'unknown' },
    },
    {
      method: 'PUT',
      path: `${base}/instances/browser`,
      body: { capabilities: [42] },
    },
    {
      method: 'PUT',
      path: `${base}/instances/browser/sessions/alice-session`,
      body: { generationId: { forged: true } },
    },
    {
      method: 'PUT',
      path: `${base}/instances/browser/sessions/alice-session`,
      body: {
        generationId: 'generation-1',
        connectedAtEpochMs: 2,
        lastHeartbeatAtEpochMs: 1,
      },
    },
    {
      method: 'POST',
      path: `${base}/instances/browser/sessions/alice-session/heartbeat`,
      body: { generationId: 'generation-1', lastHeartbeatAtEpochMs: -1 },
    },
    {
      method: 'POST',
      path: `${base}/instances/browser/sessions/alice-session/heartbeat`,
      body: {
        generationId: 'generation-1',
        lastHeartbeatAtEpochMs: 2,
        expiresAtEpochMs: 1,
      },
    },
    {
      method: 'POST',
      path: `${base}/instances/browser/sessions/alice-session/disconnect`,
      body: {},
    },
    {
      method: 'POST',
      path: `${base}/instances/browser/sessions/alice-session/disconnect`,
      body: {
        generationId: 'generation-1',
        disconnectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 2,
      },
    },
  ] as const;

  for (const testCase of cases) {
    const response = await app.request(`${testCase.path}/requests/${REQUEST_ID}`, {
      method: testCase.method,
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(testCase.body),
    });
    assert.equal(response.status, 400, testCase.path);
    assert.match((await response.json()).message, /Client|client/);
  }
  assert.equal(processCalls.length, 0);
});

Deno.test('client REST lifecycle accepts equal causal timestamp boundaries', async () => {
  const processCalls: unknown[] = [];
  const deps = createClientRouteDeps({
    session: createAuthSession('alice'),
    clientService: {},
    processClientAppInbox: (input) => {
      processCalls.push(input);
      return Promise.resolve(toClientStateWritten(createClientSnapshot('alice')));
    },
  });
  const app = createClientRouteApp(deps);
  const session =
    '/api/state/apps/app-1/workspaces/workspace-1/clients/alice/instances/browser/sessions/alice-session';
  const cases = [
    {
      method: 'PUT',
      path: session,
      body: {
        generationId: 'generation-connect',
        authenticatedAtEpochMs: 1,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 1,
      },
    },
    {
      method: 'POST',
      path: `${session}/heartbeat`,
      body: {
        generationId: 'generation-heartbeat',
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 1,
      },
    },
    {
      method: 'POST',
      path: `${session}/disconnect`,
      body: {
        generationId: 'generation-disconnect',
        disconnectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 1,
      },
    },
  ] as const;

  for (const testCase of cases) {
    const response = await app.request(`${testCase.path}/requests/${REQUEST_ID}`, {
      method: testCase.method,
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(testCase.body),
    });
    assert.equal(response.status, 200, testCase.path);
  }
  assert.equal(processCalls.length, 3);
});

Deno.test('client REST mutation preserves explicit terminal idempotency 409', async () => {
  const conflict = Object.assign(
    new Error('Client mutation command differs for request same-request'),
    {
      code: 'client-mutation-idempotency-conflict',
      status: 409,
    },
  );
  let processCount = 0;
  const deps = createClientRouteDeps({
    session: createAuthSession('alice'),
    clientService: {},
    processClientAppInbox: () => {
      processCount += 1;
      return Promise.reject(conflict);
    },
  });
  const response = await createClientRouteApp(deps).request(
    `/api/state/apps/app-1/workspaces/workspace-1/clients/alice/principal/requests/${REQUEST_ID}`,
    {
      method: 'PUT',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        username: 'alice',
        metadata: { beta: 2, alpha: 1 },
      }),
    },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    type: 'api-mutation-failure',
    version: 'canonical.v1',
    code: 'client-mutation-idempotency-conflict',
    status: 409,
    message: 'Client mutation command differs for request same-request',
    issues: null,
    denial: null,
    retry: null,
  });
  assert.equal(processCount, 1);
});

Deno.test('client mutation routes hydrate the receiving node cache from remotely processed results', async () => {
  const baseSnapshot = createClientSnapshot('alice');
  const snapshot: ClientSnapshot = {
    ...baseSnapshot,
    stateRevision: 3,
    principal: {
      ...baseSnapshot.principal,
      snapshotVersion: 3,
      presenceVersion: 2,
    },
    activeSessions: [{
      ...TEST_SCOPE,
      principalId: 'alice',
      clientInstanceId: 'instance-1',
      sessionId: 'alice-session',
      generationId: 'generation-1',
      generationVersion: 1,
      status: 'active',
      presenceState: 'online',
      transport: 'ws',
      connectionId: 'connection-1',
      authenticatedAtEpochMs: 1,
      connectedAtEpochMs: 1,
      lastHeartbeatAtEpochMs: 1,
      expiresAtEpochMs: 9_999_999_999_999,
      disconnectedAtEpochMs: null,
      disconnectReason: null,
    }],
    isOnline: true,
    activeSessionCount: 1,
    lastSeenAtEpochMs: 1,
  };
  const hydrationInputs: unknown[] = [];
  let cachedSnapshot = baseSnapshot;
  const app = new Hono();
  clientStateRoutes.registerClientStateRoutes(app, {
    clientStateService: {
      listSnapshots: () => Promise.resolve([]),
      readSnapshot: () => Promise.resolve(cachedSnapshot),
      readPresenceSnapshot: () => Promise.resolve(undefined),
      listEvents: () => Promise.resolve([]),
      listEventPage: () => Promise.resolve({ events: [], hasMore: false }),
    },
    requireApiAuthSession: () => Promise.resolve(createAuthSession('alice')),
    processClientAppInbox: <V>(_input: AppInboxEnqueueInput<V>) =>
      Promise.resolve(Either.ofRight({
        status: 'ok',
        result: Either.ofRight({ snapshot, event: null }),
      })),
    hydrateStateSyncSnapshotCaches: (input) => {
      hydrationInputs.push(input);
      cachedSnapshot = input.clients?.[0] ?? cachedSnapshot;
      return Promise.resolve({ clientSnapshotCount: 1, groupSnapshotCount: 0 });
    },
    readClientSnapshot: () =>
      Promise.resolve({ status: 'found', source: 'cache', snapshot: cachedSnapshot }),
  });

  const response = await app.request(
    '/api/state/apps/app-1/workspaces/workspace-1/clients/alice/instances/' +
      `instance-1/sessions/alice-session/requests/${REQUEST_ID}`,
    {
      method: 'PUT',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        generationId: 'generation-1',
        authenticatedAtEpochMs: 1,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 9_999_999_999_999,
      }),
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), snapshot);
  assert.deepEqual(hydrationInputs, [{ clients: [snapshot] }]);

  const readResponse = await app.request(
    '/api/state/apps/app-1/workspaces/workspace-1/clients/alice',
    { headers: { authorization: 'Bearer token' } },
  );

  assert.equal(readResponse.status, 200);
  assert.deepEqual(await readResponse.json(), snapshot);
});

Deno.test('client mutation routes preserve committed success when cache hydration fails', async () => {
  const snapshot = createClientSnapshot('alice');
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const deps = createClientRouteDeps({
      session: createAuthSession('alice'),
      clientService: {},
      processClientAppInbox: () =>
        Promise.resolve({
          status: 'ok',
          result: Either.ofRight({ snapshot, event: null }),
        }),
      hydrateStateSyncSnapshotCaches: () =>
        Promise.reject(new Error('local cache observer failed')),
    });
    const app = createClientRouteApp(deps);

    const response = await app.request(
      `/api/state/apps/app-1/workspaces/workspace-1/clients/alice/principal/requests/${REQUEST_ID}`,
      {
        method: 'PUT',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          username: 'alice',
        }),
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), snapshot);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.[0], 'Failed to hydrate client mutation snapshot cache');
  } finally {
    console.warn = originalWarn;
  }
});
