import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';

import {
  createGroupStateRouteAuthorization,
} from '../../src/group-state/group-state-route-authorization.ts';
import {
  createGroupStateRouteDependencies,
} from '../../src/group-state/create-group-state-route-dependencies.ts';
import {
  registerGroupStateReadRoutes,
} from '../../src/group-state/register-group-state-read-routes.ts';

import {
  createGroupStateRouteAuthSession,
  createGroupStateRouteEvent,
  createGroupStateRouteSnapshot,
  createGroupStateRouteTestRuntime,
} from './group-state-route-test-runtime.ts';

const API_BASE = '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1';

Deno.test('canonical group read registrar uses resolved route dependencies', async () => {
  const snapshot = createGroupStateRouteSnapshot('room-1');
  const app = new Hono();
  const dependencies = createGroupStateRouteDependencies({
    getGroupStateService: () => ({
      listSnapshots: () => Promise.resolve([snapshot]),
      readSnapshot: () => Promise.resolve(snapshot),
      readCurrentSnapshot: () => Promise.resolve(snapshot),
      listEvents: () => Promise.resolve([]),
      listEventPage: () => Promise.resolve({ events: [], hasMore: false }),
    }),
    hydrateStateSyncSnapshotCaches: () =>
      Promise.resolve({ clientSnapshotCount: 0, groupSnapshotCount: 1 }),
  });
  registerGroupStateReadRoutes(
    app,
    dependencies,
    createGroupStateRouteAuthorization(dependencies),
  );

  const response = await app.request(API_BASE);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), snapshot);
});

Deno.test(
  'canonical group read authorization evaluates strict-read configuration per request',
  async () => {
    const previous = Deno.env.get('RALLAR_STATE_STRICT_READ_AUTH');
    const app = new Hono();
    const dependencies = createGroupStateRouteDependencies({
      getGroupStateService: () => ({
        listSnapshots: () => Promise.resolve([]),
        readSnapshot: () => Promise.resolve(undefined),
        readCurrentSnapshot: () =>
          Promise.resolve(createGroupStateRouteSnapshot('room-1', ['bob'])),
        listEvents: () => Promise.resolve([]),
        listEventPage: () => Promise.resolve({ events: [], hasMore: false }),
      }),
      requireApiAuthSession: () => Promise.resolve(createGroupStateRouteAuthSession('alice')),
    });
    registerGroupStateReadRoutes(
      app,
      dependencies,
      createGroupStateRouteAuthorization(dependencies),
    );

    Deno.env.set('RALLAR_STATE_STRICT_READ_AUTH', 'yes');
    try {
      const response = await app.request(API_BASE);

      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, 'group-policy-denied');
    } finally {
      if (previous === undefined) {
        Deno.env.delete('RALLAR_STATE_STRICT_READ_AUTH');
      } else {
        Deno.env.set('RALLAR_STATE_STRICT_READ_AUTH', previous);
      }
    }
  },
);

Deno.test('canonical group list reads filter snapshots with strict-read authorization', async () => {
  const previous = Deno.env.get('RALLAR_STATE_STRICT_READ_AUTH');
  const allowedSnapshot = createGroupStateRouteSnapshot('room-1', ['alice']);
  const deniedSnapshot = createGroupStateRouteSnapshot('room-2', ['bob']);
  const app = new Hono();
  const dependencies = createGroupStateRouteDependencies({
    getGroupStateService: () => ({
      listSnapshots: () => Promise.resolve([allowedSnapshot, deniedSnapshot]),
      readSnapshot: () => Promise.resolve(undefined),
      readCurrentSnapshot: () => Promise.resolve(undefined),
      listEvents: () => Promise.resolve([]),
      listEventPage: () => Promise.resolve({ events: [], hasMore: false }),
    }),
    requireApiAuthSession: () => Promise.resolve(createGroupStateRouteAuthSession('alice')),
    hydrateStateSyncSnapshotCaches: () =>
      Promise.resolve({ clientSnapshotCount: 0, groupSnapshotCount: 1 }),
  });
  registerGroupStateReadRoutes(
    app,
    dependencies,
    createGroupStateRouteAuthorization(dependencies),
  );

  Deno.env.set('RALLAR_STATE_STRICT_READ_AUTH', 'true');
  try {
    const response = await app.request(API_BASE.replace('/room-1', ''));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [allowedSnapshot]);
  } finally {
    if (previous === undefined) {
      Deno.env.delete('RALLAR_STATE_STRICT_READ_AUTH');
    } else {
      Deno.env.set('RALLAR_STATE_STRICT_READ_AUTH', previous);
    }
  }
});

Deno.test(
  'group point reads retain normal, missing, and non-blocking cache cleanup exits',
  async () => {
    const snapshot = createGroupStateRouteSnapshot('room-1');
    let hydrationCalls = 0;
    const runtime = createGroupStateRouteTestRuntime({
      groupService: { readCurrentSnapshot: () => Promise.resolve(snapshot) },
      hydrateStateSyncSnapshotCaches: () => {
        hydrationCalls += 1;
        return Promise.reject(new Error('cache observation failed'));
      },
    });

    const response = await runtime.app.request(API_BASE);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), snapshot);
    assert.equal(hydrationCalls, 1);

    const missing = createGroupStateRouteTestRuntime({
      groupService: { readCurrentSnapshot: () => Promise.resolve(undefined) },
    });
    const missingResponse = await missing.app.request(API_BASE);

    assert.equal(missingResponse.status, 404);
    assert.deepEqual(
      await missingResponse.json(),
      { error: 'Group not found: room-1' },
    );
  },
);

Deno.test(
  'group event routes retain recent-list fallback and paged-service ownership',
  async () => {
    const event = createGroupStateRouteEvent('event-1');
    let listEventsCalls = 0;
    let listPageCalls = 0;
    const runtime = createGroupStateRouteTestRuntime({
      groupService: {
        listEvents: () => {
          listEventsCalls += 1;
          return Promise.resolve([event]);
        },
        listEventPage: () => {
          listPageCalls += 1;
          return Promise.resolve({ events: [event], hasMore: false });
        },
      },
    });

    const arrayResponse = await runtime.app.request(`${API_BASE}/events?limit=1`);
    const pageResponse = await runtime.app.request(`${API_BASE}/events/page?limit=1`);

    assert.equal(arrayResponse.status, 200);
    assert.deepEqual(await arrayResponse.json(), [event]);
    assert.equal(pageResponse.status, 200);
    assert.deepEqual(await pageResponse.json(), { events: [event], hasMore: false });
    assert.equal(listEventsCalls, 1);
    assert.equal(listPageCalls, 1);
  },
);
