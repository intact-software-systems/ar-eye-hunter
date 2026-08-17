import type { Hono } from 'jsr:@hono/hono@4.11.9';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { defaultRepositoryManager } from '@shared/cache/defaultRepositoryManager.ts';
import type { AppDataRepositoryLike } from '@shared-server/app-data/AppDataRepository.ts';
import { PSqlAppDataRepository } from '@shared-server/postgres/app-data/PSqlAppDataRepository.ts';
import { PSqlCrdtLogRepository } from '@shared-server/postgres/crdt/PSqlCrdtLogRepository.ts';
import type { RallarCrdtAdminLogRepository, RallarCrdtAuditSink } from '@shared/crdt/mod.ts';
import {
  createRallarServerApplication,
  type RallarServerApplication,
} from '@shared-server/rallar-facade/RallarServerApplication.ts';
import {
  RallarServerDataFacade,
  RallarServerSystemFacade,
} from '@shared-server/rallar-facade/RallarServer.ts';
import type {
  RallarRtcTopologyServiceOptions,
} from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import type { RallarServerWsFacadeOptions } from '@shared-server/rallar-facade/ws-topic-router.ts';
import type { ApiV1Runtime } from './composition/api-v1-runtime.ts';
import {
  createApiV1AdminServices,
  readApiV1WebSocketStatus,
} from './composition/create-api-v1-admin-services.ts';
import { createApiV1RouteInstallers } from './composition/create-api-v1-route-installers.ts';
import { createApiV1SystemInstallers } from './composition/create-api-v1-system-installers.ts';
import { createApiV1TopologyServices } from './composition/create-api-v1-topology-services.ts';
import { initialiseMiddleware } from './initialise-middleware.ts';
import {
  getApiRtcTopologyServiceOptions,
  readApiGlobalGraphRecomputeLimit,
  readApiRtcRttRefinementGateConfig,
} from './services/rtc-topology-config.ts';
import { getApiTimingSink } from './services/timing-service.ts';
import { createApiV1RoomWsAuthorizer } from './services/ws-topic-room-authorizer.ts';
import { readConfiguredCrdtPolicies } from './services/create-api-mutation-inbox-factories.ts';
import { sql } from './db/db.ts';
import { toPSqlSql } from './db/to-p-sql-sql.ts';
import { readApiV1DatabaseBackendConfig } from './db/database-config.ts';
import { readApiV1DatabasePubSubConfig } from './db/database-pubsub-config.ts';
import { myServerId } from './runtime/runtime-identity.ts';
import {
  createAuthUserRepository,
  createRuntimeStateRepository,
} from '@shared-server/postgres/rallar-system/createStateRepositories.ts';
import { readAuthorisedClients } from './services/api-login-service.ts';
import { readAdminClientIds } from './services/read-admin-client-ids.ts';

export { RallarServerDataFacade, RallarServerSystemFacade };

export type CreateRallarServerOptions = Readonly<{
  middleware?: ApiV1Runtime;
  repositories?: RepositoryManager;
  appDataRepository?: AppDataRepositoryLike;
  crdtLogRepository?: RallarCrdtAdminLogRepository;
  crdtAuditSink?: RallarCrdtAuditSink;
  ws?: RallarServerWsFacadeOptions;
  rtcTopologyOptions?: RallarRtcTopologyServiceOptions;
}>;

export function createRallarServer(
  options: CreateRallarServerOptions = {},
): RallarServerApplication<ApiV1Runtime, Hono> {
  const crdtPolicies = readConfiguredCrdtPolicies();
  const middleware = options.middleware ?? initialiseMiddleware();
  const database = toPSqlSql(sql);

  const crdtLogRepository = options.crdtLogRepository ??
    new PSqlCrdtLogRepository(database, {
      serverId: myServerId,
      audit: options.crdtAuditSink,
      policies: crdtPolicies,
    });
  middleware.appCrdtInboxService?.setAuditSink(options.crdtAuditSink);

  const runtimeStateRepository = createRuntimeStateRepository(database);
  const authUserRepository = createAuthUserRepository(runtimeStateRepository);
  const configuredRtcTopologyOptions = options.rtcTopologyOptions ??
    getApiRtcTopologyServiceOptions();
  const now = configuredRtcTopologyOptions.now ?? (() => Date.now());
  const timing = getApiTimingSink();
  const adminClientIds = readAdminClientIds();
  const topology = createApiV1TopologyServices({
    runtimeStateRepository,
    groupStateService: middleware.groupStateService,
    groupInbox: middleware.appGroupInboxService,
    groupFormationRttMutation: middleware.groupFormationMetrics.rttMutation,
    webSocketServer: middleware.wsQBoxServerService.socket,
    topologyReplayMetrics: middleware.rtcTopologyReplay,
    serviceId: myServerId,
    adminClientIds,
    rtcTopologyOptions: configuredRtcTopologyOptions,
    rttRefinementGateConfig: readApiRtcRttRefinementGateConfig(),
    nowEpochMs: now,
    timing,
  });

  const databaseConfig = readApiV1DatabaseBackendConfig();
  const databasePubSubConfig = readApiV1DatabasePubSubConfig(Deno.env, databaseConfig);
  const appAdminInboxService = middleware.appAdminInboxService;
  const appCrdtInboxService = middleware.appCrdtInboxService;

  if (!appAdminInboxService || !appCrdtInboxService) {
    throw new Error('Admin database mutations require AppInbox services');
  }

  const admin = createApiV1AdminServices({
    database,
    databaseConfig,
    databasePubSub: databasePubSubConfig,
    nowEpochMs: now,
    serviceId: myServerId,
    timing,
    readWebSocketStatus: () => readApiV1WebSocketStatus(middleware.wsQBoxServerService.socket),
    readRtcTopologyMetrics: topology.readRtcTopologyMetrics,
    resetRtcTopologyMetrics: topology.resetRtcTopologyMetrics,
    readGroupFormationMetrics: middleware.groupFormationMetrics.readMetrics,
    resetGroupFormationMetrics: middleware.groupFormationMetrics.resetMetrics,
    crdtAdminRepository: crdtLogRepository,
    topologyManagement: topology.topologyManagement,
    clientStateService: middleware.clientStateService,
    groupStateService: middleware.groupStateService,
    appAdminInboxService,
    appCrdtInboxService,
    appGroupInboxService: middleware.appGroupInboxService,
  });

  const systemInstallers = createApiV1SystemInstallers({
    database,
    serviceId: myServerId,
    nowEpochMs: now,
    topology,
    crdtLogRepository,
    crdtPolicies,
    globalGraphRecomputeLimit: readApiGlobalGraphRecomputeLimit(),
  });

  const routeInstallers = createApiV1RouteInstallers({
    runtime: middleware,
    topology,
    admin,
    crdtLogRepository,
    crdtMutations: appCrdtInboxService,
    crdtAuditSink: options.crdtAuditSink,
    authUserRepository,
    staticClients: readAuthorisedClients(Deno.env),
    authRegistrationMode: readAuthRegistrationMode(Deno.env),
    readEnv: (name) => Deno.env.get(name),
    nowEpochMs: now,
    createTokenId: () => crypto.randomUUID(),
    createWsAuthRequestFacts: () => ({
      requestId: crypto.randomUUID(),
      capturedAtEpochMs: Date.now(),
    }),
  });

  const rallarApplication = createRallarServerApplication({
    runtime: middleware,
    repositories: options.repositories ?? defaultRepositoryManager,
    ws: {
      authorizeRoomMessage: createApiV1RoomWsAuthorizer(
        middleware.groupStateService,
      ),
      ...options.ws,
    },
    appData: {
      repository: options.appDataRepository ??
        new PSqlAppDataRepository(database),
    },
    system: systemInstallers,
    routes: routeInstallers,
  });

  return rallarApplication;
}

function readAuthRegistrationMode(
  env: Pick<Deno.Env, 'get'>,
): 'public' | 'admin' {
  return env.get('AUTH_REGISTRATION_MODE')?.trim().toLowerCase() === 'admin' ? 'admin' : 'public';
}
