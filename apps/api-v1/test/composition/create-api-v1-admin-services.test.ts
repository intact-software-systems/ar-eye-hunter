import assert from 'node:assert/strict';

import type { AuthSession } from '@shared/api/api-config.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
// deno-fmt-ignore
import {
  InMemoryRallarCrdtLogRepository,
} from '@shared-server/rallar-system/crdt/persistence/in-memory-crdt-log-repository.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { emptyGroupFormationMetrics } from '@shared-server/rallar-system/formation-metrics.ts';
// deno-fmt-ignore
import type {
  GroupTopologyManagementService,
} from '@shared-server/rallar-system/topology/group-topology-management-service.ts';
// deno-fmt-ignore
import type {
  AppAdminInboxService,
} from '@shared-server/rallar-system/services/AppAdminInboxService.ts';
// deno-fmt-ignore
import type {
  AppGroupInboxService,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';

import {
  createApiV1AdminServices,
  type CreateApiV1AdminServicesInput,
  readApiV1WebSocketStatus,
} from '../../src/composition/create-api-v1-admin-services.ts';

const NOW_EPOCH_MS = 10_000;
const ADMIN_SESSION: AuthSession = {
  clientId: 'admin',
  username: 'admin',
  accessToken: 'token',
  sessionId: 'session-open',
  expiresAtEpochMs: NOW_EPOCH_MS + 1_000,
};

Deno.test('admin services read current websocket status after construction', async () => {
  const socket = new JsonWebSocketServer();
  const services = createApiV1AdminServices(
    createInput(() => readApiV1WebSocketStatus(socket)),
  );
  socket.connections.set(
    'connection-open',
    new ConnectionContext('connection-open', createSocket(WebSocket.OPEN)),
  );

  const realtime = await services.operations.readRealtime({ adminSession: ADMIN_SESSION });
  const support = await services.support.explainClient({
    adminSession: ADMIN_SESSION,
    request: {
      scope: { applicationId: 'app', workspaceId: 'workspace' },
      principalId: 'admin',
    },
  });
  const statistics = await services.statistics.readMyRealtimeStatus({
    authSession: ADMIN_SESSION,
    scope: { applicationId: 'app', workspaceId: 'workspace' },
  });

  assert.equal(realtime.websocket.connectionCount, 1);
  assert.equal(realtime.websocket.openConnectionCount, 1);
  assert.equal(
    support.facts.find((fact) => fact.label === 'client.websocket.openConnectionCount')?.value,
    1,
  );
  assert.equal(statistics.realtime.currentSessionOpen, false);

  socket.connections.set(
    'session-open',
    new ConnectionContext('session-open', createSocket(WebSocket.OPEN)),
  );
  const current = await services.statistics.readMyRealtimeStatus({
    authSession: ADMIN_SESSION,
    scope: { applicationId: 'app', workspaceId: 'workspace' },
  });
  assert.equal(current.realtime.currentSessionOpen, true);
});

Deno.test(
  'admin services propagate websocket status failures without an empty ' +
    'fallback',
  async () => {
    const failure = new Error('websocket status failed');
    const services = createApiV1AdminServices(
      createInput(() => {
        throw failure;
      }),
    );

    assert.throws(
      () => services.operations.readRealtime({ adminSession: ADMIN_SESSION }),
      (error) => error === failure,
    );
    await assert.rejects(
      () =>
        services.support.explainClient({
          adminSession: ADMIN_SESSION,
          request: {
            scope: { applicationId: 'app', workspaceId: 'workspace' },
            principalId: 'admin',
          },
        }),
      (error) => error === failure,
    );
    await assert.rejects(
      () =>
        services.statistics.readMyRealtimeStatus({
          authSession: ADMIN_SESSION,
          scope: { applicationId: 'app', workspaceId: 'workspace' },
        }),
      (error) => error === failure,
    );
  },
);

function createInput(
  readWebSocketStatus: CreateApiV1AdminServicesInput['readWebSocketStatus'],
): CreateApiV1AdminServicesInput {
  return {
    database: createDatabase(),
    databaseConfig: { sqlBackend: 'pglite-memory' },
    databasePubSub: { mode: 'local' },
    nowEpochMs: () => NOW_EPOCH_MS,
    serviceId: 'api-test',
    timing: () => {},
    readWebSocketStatus,
    readRtcTopologyMetrics: () => ({ rebuilds: 1 }),
    resetRtcTopologyMetrics: () => {},
    readGroupFormationMetrics: emptyGroupFormationMetrics,
    resetGroupFormationMetrics: () => {},
    crdtAdminRepository: new InMemoryRallarCrdtLogRepository({
      now: () => NOW_EPOCH_MS,
    }),
    topologyManagement: {} as GroupTopologyManagementService,
    clientStateService: {
      readSnapshot: () => Promise.resolve(undefined),
      readPresenceSnapshot: () => Promise.resolve(undefined),
      listRecentEvents: () => Promise.resolve([]),
    },
    groupStateService: {
      readSnapshot: () => Promise.resolve(undefined),
      listRecentEvents: () => Promise.resolve([]),
      listSnapshots: () => Promise.resolve([]),
      listSnapshotsPage: () =>
        Promise.resolve({
          snapshots: [],
          scannedGroupCount: 0,
          hasMore: false,
        }),
      listEvents: () => Promise.resolve([]),
    },
    appAdminInboxService: {} as AppAdminInboxService,
    crdtAdminMutations: {
      writeCrdtAdminMutation: () => Promise.reject(new Error('mutation not used')),
    },
    appGroupInboxService: {} as AppGroupInboxService,
  };
}

function createDatabase(): PSqlSql {
  return Object.assign(
    function <T>(_strings: TemplateStringsArray, ..._values: unknown[]): Promise<T> {
      return Promise.reject(new Error('query not used'));
    },
    {
      begin<T>(_operation: (transaction: PSqlSql) => Promise<T>): Promise<T> {
        return Promise.reject(new Error('transaction not used'));
      },
    },
  ) as PSqlSql;
}

function createSocket(readyState: WebSocket['readyState']): WebSocket {
  return new TestWebSocket(readyState);
}

class TestWebSocket extends EventTarget implements WebSocket {
  readonly CONNECTING = WebSocket.CONNECTING;
  readonly OPEN = WebSocket.OPEN;
  readonly CLOSING = WebSocket.CLOSING;
  readonly CLOSED = WebSocket.CLOSED;
  readonly bufferedAmount = 0;
  readonly extensions = '';
  readonly protocol = '';
  readonly url = 'ws://test.invalid';
  readonly readyState: WebSocket['readyState'];
  binaryType: BinaryType = 'blob';
  onclose: ((this: WebSocket, event: CloseEvent) => unknown) | null = null;
  onerror: ((this: WebSocket, event: Event) => unknown) | null = null;
  onmessage: ((this: WebSocket, event: MessageEvent) => unknown) | null = null;
  onopen: ((this: WebSocket, event: Event) => unknown) | null = null;

  constructor(readyState: WebSocket['readyState']) {
    super();
    this.readyState = readyState;
  }

  close(): void {}

  send(): void {}
}
