import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';

import type { ClientEvent } from '@shared/api/client-types.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';

import { registerGroupStateRoutes } from '../../src/group-state/register-group-state-routes.ts';
import * as clientStateRoutes from '../../src/routes/client-state-routes.ts';

import {
  createAuthSession,
  createClientEvent,
  createClientRouteDeps,
  createClientSnapshot,
  installClientStateRouteAuthMiddleware,
  withStrictReadAuth,
} from '../client-state/client-state-route-test-runtime.ts';
import {
  createGroupStateRouteEvent,
  createPredecessorGroupStateRouteAuthSession,
  createPredecessorGroupStateRouteSnapshot,
  createPredecessorGroupStateRouteTestDependencies,
} from '../group-state/group-state-route-test-runtime.ts';

Deno.test(
  'state read routes hydrate process snapshot caches after successful client and group REST reads',
  async () => {
    await withStrictReadAuth(false, async () => {
      const clientSnapshot = createClientSnapshot('alice');
      const groupSnapshot = createPredecessorGroupStateRouteSnapshot('room-1', ['alice']);
      const hydrationInputs: unknown[] = [];
      const clientDeps = createClientRouteDeps({
        session: createAuthSession('alice'),
        clientService: {
          listSnapshots: () => Promise.resolve([clientSnapshot]),
        },
        hydrateStateSyncSnapshotCaches: (input: unknown) => {
          hydrationInputs.push(input);
          return Promise.resolve({ clientSnapshotCount: 1, groupSnapshotCount: 0 });
        },
      });
      const groupDeps = createPredecessorGroupStateRouteTestDependencies({
        session: createPredecessorGroupStateRouteAuthSession('alice'),
        groupService: {
          readSnapshot: () => Promise.resolve(groupSnapshot),
        },
        hydrateStateSyncSnapshotCaches: (input: unknown) => {
          hydrationInputs.push(input);
          return Promise.resolve({ clientSnapshotCount: 0, groupSnapshotCount: 1 });
        },
      });
      const app = new Hono();
      installClientStateRouteAuthMiddleware(app, clientDeps.requireApiAuthSession);
      clientStateRoutes.init(app, clientDeps);
      registerGroupStateRoutes(app, groupDeps);

      const clientsResponse = await app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/clients',
        { headers: { authorization: 'Bearer token' } },
      );
      const groupResponse = await app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1',
        { headers: { authorization: 'Bearer token' } },
      );

      assert.equal(clientsResponse.status, 200);
      assert.equal(groupResponse.status, 200);
      assert.deepEqual(hydrationInputs, [
        { clients: [clientSnapshot] },
        { groups: [groupSnapshot] },
      ]);
    });
  },
);

Deno.test(
  'state event page routes call paged services instead of full-history listEvents',
  async () => {
    await withStrictReadAuth(false, async () => {
      const clientPage: StateEventPage<ClientEvent> = {
        events: [createClientEvent('client-event-1')],
        hasMore: false,
      };
      const groupPage: StateEventPage<GroupEvent> = {
        events: [createGroupStateRouteEvent('group-event-1')],
        hasMore: false,
      };
      const clientDeps = createClientRouteDeps({
        session: createAuthSession('alice'),
        clientService: {
          listEvents: () => Promise.reject(new Error('full client history should not be loaded')),
          listEventPage: () => Promise.resolve(clientPage),
        },
      });
      const groupDeps = createPredecessorGroupStateRouteTestDependencies({
        session: createPredecessorGroupStateRouteAuthSession('alice'),
        groupService: {
          listEvents: () => Promise.reject(new Error('full group history should not be loaded')),
          listEventPage: () => Promise.resolve(groupPage),
        },
      });
      const app = new Hono();
      installClientStateRouteAuthMiddleware(app, clientDeps.requireApiAuthSession);
      clientStateRoutes.init(app, clientDeps);
      registerGroupStateRoutes(app, groupDeps);

      const clientResponse = await app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/clients/alice/events/page?limit=10',
        { headers: { authorization: 'Bearer token' } },
      );
      const groupResponse = await app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/events/page?limit=10',
        { headers: { authorization: 'Bearer token' } },
      );

      assert.equal(clientResponse.status, 200);
      assert.equal(groupResponse.status, 200);
      assert.deepEqual(await clientResponse.json(), clientPage);
      assert.deepEqual(await groupResponse.json(), groupPage);
    });
  },
);

Deno.test(
  'state event array routes call bounded recent services instead of full-history listEvents',
  async () => {
    await withStrictReadAuth(false, async () => {
      const clientEvent = createClientEvent('client-event-2');
      const groupEvent = createGroupStateRouteEvent('group-event-2');
      const clientQueries: unknown[] = [];
      const groupQueries: unknown[] = [];
      const clientDeps = createClientRouteDeps({
        session: createAuthSession('alice'),
        clientService: {
          listEvents: () => Promise.reject(new Error('full client history should not be loaded')),
          listRecentEvents: (_ref, query) => {
            clientQueries.push(query);
            return Promise.resolve([clientEvent]);
          },
        },
      });
      const groupDeps = createPredecessorGroupStateRouteTestDependencies({
        session: createPredecessorGroupStateRouteAuthSession('alice'),
        groupService: {
          listEvents: () => Promise.reject(new Error('full group history should not be loaded')),
          listRecentEvents: (_ref, query) => {
            groupQueries.push(query);
            return Promise.resolve([groupEvent]);
          },
        },
      });
      const app = new Hono();
      installClientStateRouteAuthMiddleware(app, clientDeps.requireApiAuthSession);
      clientStateRoutes.init(app, clientDeps);
      registerGroupStateRoutes(app, groupDeps);

      const clientResponse = await app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/clients/alice/events?' +
          'eventType=session-connected&limit=1',
        { headers: { authorization: 'Bearer token' } },
      );
      const groupResponse = await app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/events?' +
          'eventType=member-left&limit=1',
        { headers: { authorization: 'Bearer token' } },
      );

      assert.equal(clientResponse.status, 200);
      assert.equal(groupResponse.status, 200);
      assert.deepEqual(await clientResponse.json(), [clientEvent]);
      assert.deepEqual(await groupResponse.json(), [groupEvent]);
      assert.deepEqual(clientQueries, [{
        eventTypes: ['session-connected'],
        limit: 1,
      }]);
      assert.deepEqual(groupQueries, [{
        eventTypes: ['member-left'],
        limit: 1,
      }]);
    });
  },
);
