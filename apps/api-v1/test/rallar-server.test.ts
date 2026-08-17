import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';

import { AppTopics } from '@shared/api/api-config.ts';
import {
  hashRallarCrdtUpdateEnvelope,
  InMemoryRallarCrdtAuditSink,
  RALLAR_CRDT_OPERATION_VERSION,
  RALLAR_CRDT_PROTOCOL_VERSION,
  rallarCrdtBatch,
  type RallarCrdtDocumentRef,
  type RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';
import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import { InMemoryRallarCrdtLogRepository } from '@shared-server/crdt/InMemoryRallarCrdtLogRepository.ts';
import {
  createGroupFormationMetricsRecorder,
} from '@shared-server/rallar-system/formation-metrics.ts';
import { installRallarGameAuthorityServer } from '@shared-server/game/mod.ts';

import type { ApiV1Runtime } from '../src/composition/api-v1-runtime.ts';
import { createRallarServer } from '../src/create-rallar-server.ts';
import { registerCrdtAdminRoutes as initCrdtAdminRoutes } from '../src/routes/crdt-admin-routes.ts';

Deno.test(
  'createRallarServer wires system topics, lifecycle, routes, and start',
  async () => {
    const runtime = createFakeMiddleware();
    const rallar = createRallarServer({ middleware: runtime.middleware });

    configureAndAssertDefaultServerLifecycle(rallar, runtime);
    await mountAndAssertServerRoutes(rallar);
  },
);

Deno.test(
  'createRallarServer exposes Rallar Game Authority as an explicit room-scoped WS extension',
  () => {
    const runtime = createFakeMiddleware();
    const rallar = createRallarServer({ middleware: runtime.middleware });

    const authority = installRallarGameAuthorityServer<
      { action: string },
      { tick: number },
      { kind: string }
    >({
      rallar,
      protocol: 'test-game.authority.v1',
      topicId: 'room.test-game.authority',
      authority: {
        kind: 'server',
        id: 'api-v1-test-authority',
        epoch: 1,
      },
      handleCommand: () => ({ status: 'accepted' }),
      readSnapshot: () => ({ tick: 0 }),
    });

    assert.deepEqual(authority.authority(), {
      kind: 'server',
      id: 'api-v1-test-authority',
      epoch: 1,
    });
    assert.equal(authority.status().topicId, 'room.test-game.authority');
    assert.equal(runtime.inboxTopics.some(isAuthorityTopic), false);
    assert.equal(runtime.outboxTopics.some(isAuthorityTopic), false);
  },
);

Deno.test(
  'createRallarServer rejects unsupported game authority topic namespaces',
  () => {
    const runtime = createFakeMiddleware();
    const rallar = createRallarServer({ middleware: runtime.middleware });

    assert.throws(
      () =>
        installRallarGameAuthorityServer<
          { action: string },
          { tick: number },
          { kind: string }
        >({
          rallar,
          protocol: 'test-game.authority.v1',
          topicId: 'game.test-game.authority',
          handleCommand: () => ({ status: 'accepted' }),
        }),
      /Rallar user WS topic must start with app\. or room\./,
    );
  },
);

Deno.test('CRDT admin routes expose read-only repository health operations', async () => {
  const audit = new InMemoryRallarCrdtAuditSink();
  const repository = new InMemoryRallarCrdtLogRepository({
    now: () => 10_000,
    audit,
  });
  const update = createCrdtUpdate('update-1');
  await repository.append({
    update,
    trusted: {
      authorizationScope: 'room',
      actorId: 'actor-a',
      principalId: 'principal-a',
      sessionId: 'session-a',
      serverId: 'server-a',
      acceptedAtEpochMs: 10_000,
    },
  });

  const app = new Hono();
  initCrdtAdminRoutes(app, {
    repository,
    audit,
    now: () => 12_000,
    requireAuth: false,
    requireApiAdminSession: () => Promise.reject(new Error('auth disabled')),
    requireApiUserSession: () => Promise.reject(new Error('auth disabled')),
  });

  const list = await postJson(app, '/api/crdt/admin/documents/list', {});
  assert.equal(list.ok, true);
  assert.equal(list.result.documents.length, 1);
  assert.equal(list.result.documents[0].updateCount, 1);

  const integrity = await postJson(app, '/api/crdt/admin/documents/integrity', {
    document: update.document,
  });
  assert.equal(integrity.ok, true);
  assert.equal(integrity.result.valid, true);
  assert.equal(integrity.result.checkedUpdateCount, 1);

  const debug = await postJson(app, '/api/crdt/admin/documents/debug-export', {
    document: update.document,
    reason: 'test-export',
  });
  assert.equal(debug.ok, true);
  assert.equal(debug.result.format, 'rallar.crdt.debug-bundle.v1');
  assert.equal(debug.result.redaction.payloadsRedacted, true);
  assert.deepEqual(debug.result.records[0].update.payload.operations, []);
});

type RallarServer = ReturnType<typeof createRallarServer>;

interface FakeMiddlewareState {
  readonly inboxTopics: string[];
  readonly outboxTopics: string[];
  readonly anyInboxCallbackIds: Set<string>;
  readonly websocketCallbackIds: Set<string>;
  readonly appInboxTopics: string[];
  readonly appOutboxTopics: string[];
  readonly appGroupInboxLifecycle: string[];
  starts: number;
}

interface FakeRuntime extends Readonly<FakeMiddlewareState> {
  readonly middleware: ApiV1Runtime;
}

function createFakeWebSocketQueue(
  state: FakeMiddlewareState,
): WsQueueBoxServerService {
  const socket = {
    onWebsocketCallbacksDo(id: string): unknown {
      state.websocketCallbackIds.add(id);
      return this;
    },
    addConnection(): void {},
  };

  return {
    socket,
    onInboxMessageDo(topicId: string): unknown {
      state.inboxTopics.push(topicId);
      return this;
    },
    onOutboxMessageDo(topicId: string): unknown {
      state.outboxTopics.push(topicId);
      return this;
    },
    onAnyInboxMessageDo(id: string): unknown {
      state.anyInboxCallbackIds.add(id);
      return this;
    },
    enqueueOutboxIfAbsent(): Promise<undefined> {
      return Promise.resolve(undefined);
    },
  } as unknown as WsQueueBoxServerService;
}

function createFakeMiddlewareRuntime(
  state: FakeMiddlewareState,
  wsQBoxServerService: WsQueueBoxServerService,
): ApiV1Runtime {
  return {
    qboxEngine: {
      start(): void {
        state.starts += 1;
        state.appGroupInboxLifecycle.push('start');
      },
      wake(): void {},
    },
    inboxQueueReader: {
      onInboxMessageDo(topicId: string): unknown {
        state.appInboxTopics.push(topicId);
        return this;
      },
    },
    outboxQueueReader: {
      onOutboxMessageDo(topicId: string): unknown {
        state.appOutboxTopics.push(topicId);
        return this;
      },
    },
    wsQBoxServerService,
    appGroupInboxService: {
      setTopologyManagementService(): void {
        state.appGroupInboxLifecycle.push('topology');
      },
      setRtcRttAppInboxDependencies(): void {
        state.appGroupInboxLifecycle.push('rtc-rtt');
      },
    },
    appAdminInboxService: {},
    appCrdtInboxService: {
      setAuditSink(): void {},
    },
    authSessionRepository: {
      findByAccessToken: () => Promise.resolve(undefined),
    },
    backgroundTasks: {
      beginStartupGeneration: () => ({} as never),
      register: () => () => {},
      stop: () => Promise.resolve(),
    },
    clientsRepository: {},
    groupsRepository: {},
    groupFormationMetrics: createGroupFormationMetricsRecorder(),
  } as unknown as ApiV1Runtime;
}

function createFakeMiddleware(): FakeRuntime {
  const state: FakeMiddlewareState = {
    inboxTopics: [],
    outboxTopics: [],
    anyInboxCallbackIds: new Set<string>(),
    websocketCallbackIds: new Set<string>(),
    appInboxTopics: [],
    appOutboxTopics: [],
    appGroupInboxLifecycle: [],
    starts: 0,
  };
  const wsQBoxServerService = createFakeWebSocketQueue(state);
  const runtime = createFakeMiddlewareRuntime(state, wsQBoxServerService);

  return {
    middleware: runtime,
    inboxTopics: state.inboxTopics,
    outboxTopics: state.outboxTopics,
    anyInboxCallbackIds: state.anyInboxCallbackIds,
    websocketCallbackIds: state.websocketCallbackIds,
    appInboxTopics: state.appInboxTopics,
    appOutboxTopics: state.appOutboxTopics,
    appGroupInboxLifecycle: state.appGroupInboxLifecycle,
    get starts() {
      return state.starts;
    },
  };
}

function configureAndAssertDefaultServerLifecycle(
  rallar: RallarServer,
  runtime: FakeRuntime,
): void {
  rallar.system
    .useDefaultMiddlewareTopics()
    .useDefaultMiddlewareTopics()
    .useWebSocketLifecycle()
    .useWebSocketLifecycle();
  rallar.start();

  assert.equal(runtime.starts, 1);
  assert.deepEqual(runtime.appGroupInboxLifecycle, ['topology', 'rtc-rtt', 'start']);
  assert.deepEqual(runtime.inboxTopics, [
    AppTopics.clientStateSnapshot,
    AppTopics.clientStateEvent,
    AppTopics.groupStateSnapshot,
    AppTopics.groupDirectorySnapshot,
    AppTopics.groupStateEvent,
    AppTopics.graphs,
    AppTopics.overlayTopology,
    AppTopics.chat,
    AppTopics.rtt,
    AppTopics.rtcSignaling,
  ]);
  assert.equal(runtime.inboxTopics.some(isAuthorityTopic), false);
  assert.deepEqual(runtime.outboxTopics, [
    AppTopics.clientStateSnapshot,
    AppTopics.clientStateEvent,
    AppTopics.groupStateSnapshot,
    AppTopics.groupDirectorySnapshot,
    AppTopics.groupStateEvent,
    AppTopics.graphs,
    AppTopics.overlayTopology,
  ]);
  assert.equal(runtime.outboxTopics.some(isAuthorityTopic), false);
  assert.deepEqual([...runtime.anyInboxCallbackIds], ['dynamic-ws-topic-router']);
  assert.deepEqual([...runtime.websocketCallbackIds], ['handle-ws-lifecycle']);
  assert.deepEqual(runtime.appInboxTopics, []);
  assert.deepEqual(runtime.appOutboxTopics, ['RTC_TOPOLOGY_RECOMPUTE']);
}

async function mountAndAssertServerRoutes(rallar: RallarServer): Promise<void> {
  const app = new Hono();
  rallar.ws.mount(app).mount(app);
  rallar.rest.mount(app).mount(app);

  assert.equal((await app.request('/api/ws/session-1')).status, 426);
  assert.equal((await app.request('/api/docs')).status, 200);
  for (const removedPath of ['/api/graph', '/api/graph/tree/room-1']) {
    const removedResponse = await app.request(removedPath);
    assert.equal(removedResponse.status, 302);
    assert.equal(removedResponse.headers.get('location'), '/swagger-ui');
  }
  assert.equal((await app.request('/api/admin/operations/overview')).status, 401);
  assert.equal(
    (await app.request('/api/admin/support/explain/queue-item', {
      method: 'POST',
    })).status,
    401,
  );
  assert.equal(
    (await app.request(
      '/api/state/apps/app-1/workspaces/workspace-1/graphs/global?refresh=bogus',
    )).status,
    400,
  );
}

const CRDT_ROOM_REF = {
  applicationId: 'rallar-test',
  workspaceId: 'main',
  groupId: 'room-1',
};

const CRDT_DOCUMENT_REF: RallarCrdtDocumentRef = {
  applicationId: 'rallar-test',
  workspaceId: 'main',
  scope: 'room',
  documentType: 'checklist',
  documentId: 'room-1',
  roomRef: CRDT_ROOM_REF,
};

function createCrdtUpdate(updateId: string): RallarCrdtUpdateEnvelope {
  const updateWithoutHash: RallarCrdtUpdateEnvelope = {
    protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
    document: CRDT_DOCUMENT_REF,
    updateId,
    replicaId: 'replica-a',
    actorId: 'actor-a',
    lamport: 1,
    parents: [],
    schemaVersion: 1,
    operationVersion: RALLAR_CRDT_OPERATION_VERSION,
    createdAtEpochMs: 9_000,
    payload: rallarCrdtBatch([
      {
        kind: 'map.set',
        path: [],
        key: 'title',
        value: 'Admin route test',
      },
    ]),
  };

  return {
    ...updateWithoutHash,
    hash: hashRallarCrdtUpdateEnvelope(updateWithoutHash),
  };
}

function isAuthorityTopic(topicId: string): boolean {
  return topicId.includes('authority');
}

type CrdtAdminRouteJson = {
  ok: boolean;
  result: {
    documents: Array<{ updateCount: number }>;
    valid: boolean;
    checkedUpdateCount: number;
    format: string;
    redaction: { payloadsRedacted: boolean };
    records: Array<{ update: { payload: { operations: unknown[] } } }>;
    snapshot: { snapshotId: string };
    lifecycle: string;
    auditEvent: { kind: string };
    metadata: { lifecycle: string };
  };
};

async function postJson(app: Hono, path: string, body: unknown): Promise<CrdtAdminRouteJson> {
  const response = await app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return await response.json() as CrdtAdminRouteJson;
}
