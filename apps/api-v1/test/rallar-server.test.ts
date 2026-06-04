import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono';
import { AppTopics } from '@shared/api/api-config.ts';
import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import type { Middleware } from '../src/middleware.ts';
import { createRallarServer } from '../src/create-rallar-server.ts';

Deno.test('createRallarServer wires system topics, lifecycle, routes, and start', async () => {
  const runtime = createFakeMiddleware();
  const rallar = createRallarServer({
    middleware: runtime.middleware,
  });

  rallar.system
    .useDefaultMiddlewareTopics()
    .useDefaultMiddlewareTopics()
    .useWebSocketLifecycle()
    .useWebSocketLifecycle();
  rallar.start();

  assert.equal(runtime.starts, 1);
  assert.deepEqual(runtime.inboxTopics, [
    AppTopics.clientStateSnapshot,
    AppTopics.clientStateEvent,
    AppTopics.groupStateSnapshot,
    AppTopics.groupStateEvent,
    AppTopics.graphs,
    AppTopics.overlayTopology,
    AppTopics.chat,
    AppTopics.rtt,
    AppTopics.rtcSignaling,
  ]);
  assert.deepEqual(runtime.outboxTopics, [
    AppTopics.clientStateSnapshot,
    AppTopics.clientStateEvent,
    AppTopics.groupStateSnapshot,
    AppTopics.groupStateEvent,
    AppTopics.graphs,
    AppTopics.overlayTopology,
  ]);
  assert.deepEqual([...runtime.anyInboxCallbackIds], [
    'dynamic-ws-topic-router',
  ]);
  assert.deepEqual([...runtime.websocketCallbackIds], [
    'handle-ws-lifecycle',
  ]);

  const app = new Hono();
  rallar.ws.mount(app).mount(app);
  rallar.rest.mount(app).mount(app);

  assert.equal((await app.request('/api/ws/session-1')).status, 426);
  assert.equal((await app.request('/api/docs')).status, 200);
});

type FakeRuntime = Readonly<{
  middleware: Middleware;
  inboxTopics: string[];
  outboxTopics: string[];
  anyInboxCallbackIds: Set<string>;
  websocketCallbackIds: Set<string>;
  starts: number;
}>;

function createFakeMiddleware(): FakeRuntime {
  const inboxTopics: string[] = [];
  const outboxTopics: string[] = [];
  const anyInboxCallbackIds = new Set<string>();
  const websocketCallbackIds = new Set<string>();
  let starts = 0;

  const socket = {
    onWebsocketCallbacksDo(id: string): unknown {
      websocketCallbackIds.add(id);
      return this;
    },
    addConnection(): void {
    },
  };

  const wsQBoxServerService = {
    socket,
    onInboxMessageDo(topicId: string): unknown {
      inboxTopics.push(topicId);
      return this;
    },
    onOutboxMessageDo(topicId: string): unknown {
      outboxTopics.push(topicId);
      return this;
    },
    onAnyInboxMessageDo(id: string): unknown {
      anyInboxCallbackIds.add(id);
      return this;
    },
    enqueueOutboxIfAbsent(): Promise<undefined> {
      return Promise.resolve(undefined);
    },
  } as unknown as WsQueueBoxServerService;

  const runtime = {
    qboxEngine: {
      start(): void {
        starts += 1;
      },
    },
    wsQBoxServerService,
    clientsRepository: {},
    groupsRepository: {},
  } as unknown as Middleware;

  return {
    middleware: runtime,
    inboxTopics,
    outboxTopics,
    anyInboxCallbackIds,
    websocketCallbackIds,
    get starts() {
      return starts;
    },
  };
}
