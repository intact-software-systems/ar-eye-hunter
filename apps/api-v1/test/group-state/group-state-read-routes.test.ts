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
  createDeletedGroupStateRouteSnapshot,
  createGroupStateRouteAuthSession,
  createGroupStateRouteEvent,
  createGroupStateRouteSnapshot,
  createGroupStateRouteSnapshotWithMember,
  createGroupStateRouteTestDependencies,
  createGroupStateRouteTestRuntime,
  withStrictGroupStateRouteReadAuth,
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

Deno.test('strict state read routes allow active group members and reject non-members', async () => {
  await withStrictGroupStateRouteReadAuth(true, async () => {
    const memberSnapshot = createGroupStateRouteSnapshot('room-1', ['alice']);
    const nonMemberSnapshot = createGroupStateRouteSnapshot('room-2', ['bob']);
    const { app } = createGroupStateRouteTestRuntime({
      session: createGroupStateRouteAuthSession('alice'),
      groupService: {
        readSnapshot: (ref: { groupId: string }) =>
          Promise.resolve(
            ref.groupId === 'room-1' ? memberSnapshot : nonMemberSnapshot,
          ),
      },
    });

    const allowed = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1',
      { headers: { authorization: 'Bearer token' } },
    );
    const denied = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-2',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), memberSnapshot);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'group-policy-denied');
  });
});

Deno.test('group snapshot reads probe durable state instead of trusting a warm cache', async () => {
  await withStrictGroupStateRouteReadAuth(false, async () => {
    const staleSnapshot = createGroupStateRouteSnapshot('room-1', ['alice']);
    const currentSnapshot = createGroupStateRouteSnapshot('room-1', ['alice', 'bob']);
    let cachedReadCount = 0;
    let currentReadCount = 0;
    const groupService = {
      readSnapshot: () => {
        cachedReadCount += 1;
        return Promise.resolve(staleSnapshot);
      },
      readCurrentSnapshot: () => {
        currentReadCount += 1;
        return Promise.resolve(currentSnapshot);
      },
    };
    const { app } = createGroupStateRouteTestRuntime({
      session: createGroupStateRouteAuthSession('alice'),
      groupService,
    });

    const response = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), currentSnapshot);
    assert.equal(cachedReadCount, 0);
    assert.equal(currentReadCount, 1);
  });
});

Deno.test('strict group reads reject banned members for snapshots and events', async () => {
  await withStrictGroupStateRouteReadAuth(true, async () => {
    const bannedSnapshot = createGroupStateRouteSnapshotWithMember(
      'room-1',
      'alice',
      'banned',
    );
    const { app } = createGroupStateRouteTestRuntime({
      session: createGroupStateRouteAuthSession('alice'),
      groupService: {
        readSnapshot: () => Promise.resolve(bannedSnapshot),
        listEvents: () => Promise.reject(new Error('banned member read leaked')),
        listEventPage: () => Promise.reject(new Error('banned member read leaked')),
      },
    });

    const snapshotResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1',
      { headers: { authorization: 'Bearer token' } },
    );
    const eventsResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/events/page',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(snapshotResponse.status, 403);
    assert.equal(eventsResponse.status, 403);
    assert.equal((await snapshotResponse.json()).code, 'member-banned');
  });
});

Deno.test('strict group reads use shared full-state visibility policy', async () => {
  await withStrictGroupStateRouteReadAuth(true, async () => {
    const invitedSnapshot = createGroupStateRouteSnapshotWithMember(
      'room-invited',
      'alice',
      'invited',
    );
    const deletedSnapshot = createDeletedGroupStateRouteSnapshot('room-deleted', 'alice');
    const { app } = createGroupStateRouteTestRuntime({
      session: createGroupStateRouteAuthSession('alice'),
      groupService: {
        readSnapshot: (ref: { groupId: string }) =>
          Promise.resolve(
            ref.groupId === 'room-deleted' ? deletedSnapshot : invitedSnapshot,
          ),
        listEventPage: () =>
          Promise.resolve({
            events: [createGroupStateRouteEvent('event-1')],
            hasMore: false,
          }),
      },
    });

    const invitedSnapshotResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-invited',
      { headers: { authorization: 'Bearer token' } },
    );
    const invitedEventsResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-invited/events/page',
      { headers: { authorization: 'Bearer token' } },
    );
    const deletedSnapshotResponse = await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/groups/room-deleted',
      { headers: { authorization: 'Bearer token' } },
    );

    assert.equal(invitedSnapshotResponse.status, 403);
    assert.equal(invitedEventsResponse.status, 403);
    assert.equal(deletedSnapshotResponse.status, 403);
    assert.equal((await invitedSnapshotResponse.json()).code, 'group-policy-denied');
    assert.equal((await invitedEventsResponse.json()).code, 'group-policy-denied');
    assert.equal((await deletedSnapshotResponse.json()).code, 'group-deleted');
  });
});
