import assert from 'node:assert/strict';

import {
  createAuthSession,
  createClientEvent,
  createClientRouteApp,
  createClientRouteDeps,
  createClientSnapshot,
  withStrictReadAuth,
} from './client-state-route-test-runtime.ts';

Deno.test('non-strict state read routes preserve authenticated non-self client reads', async () => {
  await withStrictReadAuth(false, async () => {
    const snapshot = createClientSnapshot('bob');
    const deps = createClientRouteDeps({
      session: createAuthSession('alice'),
      clientService: {
        readSnapshot: () => Promise.resolve(snapshot),
      },
    });
    const app = createClientRouteApp(deps);

    const response = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/clients/bob',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), snapshot);
    assert.equal(deps.authCallCount(), 1);
  });
});

Deno.test('strict state read routes reject non-self client snapshot and event reads', async () => {
  await withStrictReadAuth(true, async () => {
    const deps = createClientRouteDeps({
      session: createAuthSession('alice'),
      clientService: {
        readSnapshot: () => Promise.resolve(createClientSnapshot('bob')),
        listEventPage: () =>
          Promise.resolve({
            events: [createClientEvent('bob-event')],
            hasMore: false,
          }),
      },
    });
    const app = createClientRouteApp(deps);

    const snapshotResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/clients/bob',
      { headers: { authorization: 'Bearer token' } },
    );
    const eventsResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/clients/bob/events/page',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(snapshotResponse.status, 403);
    assert.equal(eventsResponse.status, 403);
    assert.deepEqual(await snapshotResponse.json(), {
      error: 'Forbidden: state read principal id does not match authenticated client',
    });
  });
});
