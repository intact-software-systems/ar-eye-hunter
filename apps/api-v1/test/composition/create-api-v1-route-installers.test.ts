import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';

import { InMemoryRallarCrdtLogRepository } from '@shared-server/crdt/InMemoryRallarCrdtLogRepository.ts';
import type { AuthUserRepository } from '@shared-server/rallar-system/auth/persistence/auth-user-repository.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';

import type { ApiV1Runtime } from '../../src/composition/api-v1-runtime.ts';
import type { ApiV1AdminServices } from '../../src/composition/create-api-v1-admin-services.ts';
import type { ApiV1TopologyServices } from '../../src/composition/create-api-v1-topology-services.ts';
import {
  createApiV1RouteInstallers,
  type CreateApiV1RouteInstallersInput,
} from '../../src/composition/create-api-v1-route-installers.ts';

Deno.test('route installers mount representative API and websocket behavior in order', async () => {
  const app = new Hono();
  const installers = createApiV1RouteInstallers(createInput());

  installers.ws(app);
  for (const install of installers.rest) {
    install(app);
  }

  assert.equal((await app.request('/api/ws/session-1')).status, 426);
  assert.equal((await app.request('/api/config')).status, 200);
  assert.equal((await app.request('/api/webrtc/ice')).status, 401);
  assert.equal(
    (await app.request('/api/state/apps/app/workspaces/workspace/clients/alice')).status,
    400,
  );
  assert.equal(
    (await app.request('/api/state/apps/app/workspaces/workspace/groups/group')).status,
    400,
  );
  assert.equal(
    (await app.request('/api/state/apps/app/workspaces/workspace/graphs/global?refresh=bogus'))
      .status,
    400,
  );
  assert.equal(
    (await app.request('/api/state/apps/app/workspaces/workspace/stats/summary')).status,
    401,
  );
  assert.equal((await app.request('/api/admin/operations/overview')).status, 401);
  assert.equal(
    (await app.request('/api/admin/support/explain/queue-item', { method: 'POST' })).status,
    401,
  );
  assert.equal((await app.request('/api/crdt/catch-up', { method: 'POST' })).status, 401);
  assert.equal((await app.request('/api/docs')).status, 200);
});

function createInput(): CreateApiV1RouteInstallersInput {
  const runtime = {
    wsQBoxServerService: { socket: {} as JsonWebSocketServer },
    authSessionRepository: {},
    appAuthInboxService: {},
    appClientInboxService: {},
    appGroupInboxService: {},
    clientStateService: {},
    groupStateService: {},
    clientRestSnapshotReadSelector: {},
    groupRestSnapshotReadSelector: {},
    groupsRepository: {},
    clientsRepository: {},
  } as ApiV1Runtime;
  return {
    runtime,
    topology: createTopology(),
    admin: {
      operations: {},
      support: {},
      statistics: {},
    } as ApiV1AdminServices,
    crdtLogRepository: new InMemoryRallarCrdtLogRepository({ now: () => 1_000 }),
    crdtMutations: {
      writeCrdtAdminMutation: () => Promise.reject(new Error('mutation not used')),
    },
    authUserRepository: {} as AuthUserRepository,
    staticClients: [],
    authRegistrationMode: 'public',
    readEnv: () => undefined,
    nowEpochMs: () => 1_000,
    createTokenId: () => 'token-id',
    createWsAuthRequestFacts: () => ({
      requestId: 'request-id',
      capturedAtEpochMs: 1_000,
    }),
  };
}

function createTopology(): ApiV1TopologyServices {
  return {
    rtcTopologyService: {} as ApiV1TopologyServices['rtcTopologyService'],
    rtcTopologyOptions: {},
    topologyManagement: {} as ApiV1TopologyServices['topologyManagement'],
    topologyConfigRepository: {} as ApiV1TopologyServices['topologyConfigRepository'],
    groupStateRepository: {} as ApiV1TopologyServices['groupStateRepository'],
    topologySnapshotRepository: {} as ApiV1TopologyServices['topologySnapshotRepository'],
    rttRepository: {} as ApiV1TopologyServices['rttRepository'],
    rttRefinementGate: {} as ApiV1TopologyServices['rttRefinementGate'],
    rttRefinementService: {} as ApiV1TopologyServices['rttRefinementService'],
    adminClientIds: ['admin'],
    readRtcTopologyMetrics: () => ({}),
    resetRtcTopologyMetrics: () => undefined,
  };
}
