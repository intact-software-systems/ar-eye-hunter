import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';

import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import type { AppDataRepositoryLike } from '@shared-server/app-data/AppDataRepository.ts';
import { installRallarGameAuthorityServer } from '@shared-server/game/mod.ts';
import type { RallarServerSystemInstallers } from '@shared-server/rallar-facade/RallarServer.ts';

import type { ApiV1Runtime } from '../../src/composition/api-v1-runtime.ts';
import type { ApiV1RouteInstallers } from '../../src/composition/create-api-v1-route-installers.ts';
import { createRallarServer } from '../../src/composition/create-rallar-server.ts';

Deno.test('required server assembly preserves explicit owners and mounts each installer once', () => {
  const state = createState();
  const runtime = createRuntime(state);
  const repositories = new RepositoryManager();
  const systemInstallers = createSystemInstallers(state);
  const routeInstallers = createRouteInstallers(state);
  const server = createRallarServer({
    runtime,
    repositories,
    appDataRepository: APP_DATA_REPOSITORY,
    ws: {},
    systemInstallers,
    routeInstallers,
  });
  const app = new Hono();

  server.system.useDefaultMiddlewareTopics().useDefaultMiddlewareTopics();
  server.system.useWebSocketLifecycle().useWebSocketLifecycle();
  server.ws.mount(app).mount(app);
  server.rest.mount(app).mount(app);
  server.start();

  assert.equal(server.runtime, runtime);
  assert.equal(server.data.repositories, repositories);
  assert.deepEqual(state.events, ['topics', 'lifecycle', 'ws-route', 'rest-route', 'start']);
});

Deno.test('required server assembly retains the room-scoped game authority surface', () => {
  const state = createState();
  const server = createRallarServer({
    runtime: createRuntime(state),
    repositories: new RepositoryManager(),
    appDataRepository: APP_DATA_REPOSITORY,
    ws: {},
    systemInstallers: createSystemInstallers(state),
    routeInstallers: createRouteInstallers(state),
  });

  const authority = installRallarGameAuthorityServer<
    { action: string },
    { tick: number },
    { kind: string }
  >({
    rallar: server,
    protocol: 'test-game.authority.v1',
    topicId: 'room.test-game.authority',
    authority: { kind: 'server', id: 'api-v1-test-authority', epoch: 1 },
    handleCommand: () => ({ status: 'accepted' }),
    readSnapshot: () => ({ tick: 0 }),
  });

  assert.deepEqual(authority.authority(), {
    kind: 'server',
    id: 'api-v1-test-authority',
    epoch: 1,
  });
  assert.equal(authority.status().topicId, 'room.test-game.authority');
  assert.throws(
    () =>
      installRallarGameAuthorityServer({
        rallar: server,
        protocol: 'test-game.authority.v1',
        topicId: 'game.test-game.authority',
        handleCommand: () => ({ status: 'accepted' }),
      }),
    /Rallar user WS topic must start with app\. or room\./,
  );
});

interface TestState {
  readonly events: string[];
}

function createState(): TestState {
  return { events: [] };
}

function createRuntime(state: TestState): ApiV1Runtime {
  const wsQBoxServerService = {
    socket: { connections: new Map() },
    onAnyInboxMessageDo: () => wsQBoxServerService,
    removeAnyInboxMessageCallback: () => true,
  };
  return Object.assign({} as ApiV1Runtime, {
    wsQBoxServerService,
    qboxEngine: {
      start: () => {
        state.events.push('start');
      },
      wake: () => {},
    },
  });
}

function createSystemInstallers(
  state: TestState,
): RallarServerSystemInstallers<ApiV1Runtime> {
  return {
    installDefaultMiddlewareTopics: (runtime) => {
      assert.ok(runtime);
      state.events.push('topics');
    },
    installWebSocketLifecycle: (runtime) => {
      assert.ok(runtime);
      state.events.push('lifecycle');
    },
  };
}

function createRouteInstallers(state: TestState): ApiV1RouteInstallers {
  return {
    ws: (app) => {
      assert.ok(app);
      state.events.push('ws-route');
    },
    rest: [
      (app) => {
        assert.ok(app);
        state.events.push('rest-route');
      },
    ],
  };
}

const APP_DATA_REPOSITORY: AppDataRepositoryLike = {
  findEntry: () => Promise.resolve(undefined),
  findEntries: () => Promise.resolve([]),
  upsert: () => Promise.resolve(),
  deleteByKey: () => Promise.resolve(false),
  deleteExpired: () => Promise.resolve(0),
};
