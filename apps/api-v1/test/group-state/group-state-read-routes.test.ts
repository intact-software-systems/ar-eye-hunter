import assert from 'node:assert/strict';

import {
  createGroupStateRouteEvent,
  createGroupStateRouteSnapshot,
  createGroupStateRouteTestRuntime,
} from './group-state-route-test-runtime.ts';

const API_BASE = '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1';

Deno.test('group point reads retain normal, missing, and non-blocking cache cleanup exits', async () => {
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
  assert.deepEqual(await missingResponse.json(), { error: 'Group not found: room-1' });
});

Deno.test('group event routes retain recent-list fallback and paged-service ownership', async () => {
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
});
