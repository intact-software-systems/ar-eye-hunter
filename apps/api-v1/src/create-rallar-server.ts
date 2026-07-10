import type { Hono } from 'jsr:@hono/hono@4.11.9';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { defaultRepositoryManager } from '@shared/cache/defaultRepositoryManager.ts';
import type { AppDataRepositoryLike } from '@shared-server/app-data/AppDataRepository.ts';
import { installRallarCrdtWsTopics } from '@shared-server/crdt/RallarCrdtServer.ts';
import { PSqlAppDataRepository } from '@shared-server/postgres/app-data/PSqlAppDataRepository.ts';
import { PSqlCrdtLogRepository } from '@shared-server/postgres/crdt/PSqlCrdtLogRepository.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import type { RallarCrdtAdminLogRepository, RallarCrdtAuditSink } from '@shared/crdt/mod.ts';
import {
  createRallarServerApplication,
  type RallarServerApplication,
} from '@shared-server/rallar-facade/RallarServerApplication.ts';
import {
  RallarServerDataFacade,
  RallarServerSystemFacade,
} from '@shared-server/rallar-facade/RallarServer.ts';
import { initRallarSystemWsTopics } from '@shared-server/rallar-system/ws-system-topics.ts';
import {
  RallarRtcTopologyService,
  type RallarRtcTopologyServiceOptions,
} from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import { AdminOperationsService } from '@shared-server/rallar-system/admin-operations/AdminOperationsService.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/repositories/RtcRttRepository.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts';
import { GroupTopologyManagementService } from '@shared-server/rallar-system/services/group-topology-management-service.ts';
import { createGroupStateSnapshotReadThroughCache } from '@shared-server/rallar-system/services/group-state-snapshot-read-through-cache.ts';
import {
  PSqlAdminOperationsPruner,
  PSqlAdminOperationsStatsReader,
} from '@shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts';
import { AdminSupportService } from '@shared-server/rallar-system/admin-support/AdminSupportService.ts';
import { PSqlAdminSupportReader } from '@shared-server/postgres/admin-support/PSqlAdminSupportReader.ts';
import { sendStateSyncMessage } from '@shared-server/rallar-system/state-sync-routing.ts';
import {
  readGroupGraphDiagnostic,
  readScopedGlobalGraphDiagnostic,
} from '@shared-graph/graph-diagnostics-service.ts';
import type { RallarServerWsFacadeOptions } from '@shared-server/rallar-facade/ws-topic-router.ts';
import type { Middleware } from './middleware.ts';
import { getMiddleware, initialiseMiddleware } from './middleware.ts';
import { getApiRtcTopologyServiceOptions } from './services/rtc-topology-config.ts';
import { getApiTimingSink } from './services/timing-service.ts';
import { createApiV1RoomWsAuthorizer } from './services/ws-topic-room-authorizer.ts';
import * as configRoutes from './routes/config-route.ts';
import * as wsRoutes from './routes/ws-routes.ts';
import * as iceRoutes from './routes/ice-route.ts';
import * as clientStateRoutes from './routes/client-state-routes.ts';
import * as groupStateRoutes from './routes/group-state-routes.ts';
import * as spaStatisticsRoutes from './routes/spa-statistics-routes.ts';
import * as graphTopologyRoutes from './routes/graph-topology-routes.ts';
import * as graphRoutes from './routes/graph-routes.ts';
import * as crdtAdminRoutes from './routes/crdt-admin-routes.ts';
import * as adminOperationsRoutes from './routes/admin-operations-routes.ts';
import * as adminSupportRoutes from './routes/admin-support-routes.ts';
import * as swaggerRoutes from './routes/swagger-routes.ts';
import { initWsLifecycle as initSharedWsLifecycle } from '@shared-server/rallar-system/services/ws-lifecycle-service.ts';
import { sql } from './db/db.ts';
import { readApiV1DatabaseBackendConfig } from './db/database-config.ts';
import { readApiV1DatabasePubSubConfig } from './db/database-pubsub-config.ts';
import { myServerId } from './runtime/runtime-identity.ts';
import { createRuntimeStateRepository } from './repository/createStateRepositories.ts';
import { SpaStatisticsService } from '@shared-server/rallar-system/spa-statistics/SpaStatisticsService.ts';

export { RallarServerDataFacade, RallarServerSystemFacade };

export type CreateRallarServerOptions = Readonly<{
  middleware?: Middleware;
  repositories?: RepositoryManager;
  appDataRepository?: AppDataRepositoryLike;
  crdtLogRepository?: RallarCrdtAdminLogRepository;
  crdtAuditSink?: RallarCrdtAuditSink;
  ws?: RallarServerWsFacadeOptions;
  rtcTopologyOptions?: RallarRtcTopologyServiceOptions;
}>;

export function createRallarServer(
  options: CreateRallarServerOptions = {},
): RallarServerApplication<Middleware, Hono> {
  const middleware = options.middleware ?? initialiseMiddleware();
  const crdtLogRepository = options.crdtLogRepository ??
    new PSqlCrdtLogRepository(sql as unknown as PSqlSql, {
      serverId: myServerId,
      audit: options.crdtAuditSink,
    });
  const runtimeStateRepository = createRuntimeStateRepository(sql);
  const rtcTopologyOptions = options.rtcTopologyOptions ??
    getApiRtcTopologyServiceOptions();
  const rtcTopologyServerDefaults = {
    ...rtcTopologyOptions,
    topologyKind: rtcTopologyOptions.topologyKind ?? 'auto' as const,
  };
  const rtcTopologyService = new RallarRtcTopologyService(rtcTopologyOptions);
  const topologyConfigRepository = new GroupTopologyConfigRepository(
    runtimeStateRepository,
  );
  const topologySnapshotRepository = new RtcTopologySnapshotRepository(
    runtimeStateRepository,
  );
  const rttRepository = new RtcRttRepository(runtimeStateRepository, {
    now: rtcTopologyOptions.now,
  });
  const groupSnapshotCache = createGroupStateSnapshotReadThroughCache({
    groupsRepository: middleware.groupsRepository,
  });
  const topologyManagement = new GroupTopologyManagementService({
    findGroupSnapshotByRef: (ref, cacheOptions) =>
      groupSnapshotCache.findOrLoadByRef(ref, cacheOptions),
    configRepository: topologyConfigRepository,
    topologyService: rtcTopologyService,
    topologySnapshotRepository,
    rttRepository,
    publisher: (message) => {
      sendStateSyncMessage(middleware.wsQBoxServerService.socket, message);
    },
    serverDefaults: rtcTopologyServerDefaults,
    now: rtcTopologyOptions.now,
  });
  const adminClientIds = readAdminClientIds();
  const databaseConfig = readApiV1DatabaseBackendConfig();
  const databasePubSubConfig = readApiV1DatabasePubSubConfig(Deno.env, databaseConfig);
  let rallarApplication: RallarServerApplication<Middleware, Hono> | undefined;
  const emptyWsStatus = {
    transport: 'ws-server' as const,
    connectionCount: 0,
    openConnectionCount: 0,
    connectionIds: [],
    openConnectionIds: [],
    connections: [],
  };
  const adminOperations = new AdminOperationsService({
    now: rtcTopologyOptions.now ?? (() => Date.now()),
    serverId: myServerId,
    statsReader: new PSqlAdminOperationsStatsReader(sql as unknown as PSqlSql, {
      now: rtcTopologyOptions.now ?? (() => Date.now()),
      serverId: myServerId,
      sqlBackend: databaseConfig.sqlBackend,
      dbPubSub: databasePubSubConfig.mode,
    }),
    pruner: new PSqlAdminOperationsPruner(sql as unknown as PSqlSql),
    wsStatus: () => rallarApplication?.ws.status() ?? emptyWsStatus,
    readRtcTopologyMetrics: () => rtcTopologyService.readMetrics(),
    resetRtcTopologyMetrics: () => rtcTopologyService.resetMetrics(),
    topologyManagement,
    crdtAdminRepository: crdtLogRepository,
    crdtAuditSink: options.crdtAuditSink,
    timing: getApiTimingSink(),
  });
  const adminSupport = new AdminSupportService({
    now: rtcTopologyOptions.now ?? (() => Date.now()),
    serverId: myServerId,
    reader: new PSqlAdminSupportReader(sql as unknown as PSqlSql),
    clientStateService: middleware.clientsRepository,
    groupStateService: middleware.groupsRepository,
    topologyManagement,
    wsStatus: () => rallarApplication?.ws.status() ?? emptyWsStatus,
    crdtAdminRepository: crdtLogRepository,
    timing: getApiTimingSink(),
  });
  const spaStatistics = new SpaStatisticsService({
    now: rtcTopologyOptions.now ?? (() => Date.now()),
    clientStateService: middleware.clientsRepository,
    groupStateService: middleware.groupsRepository,
    wsStatus: () => rallarApplication?.ws.status() ?? emptyWsStatus,
  });

  rallarApplication = createRallarServerApplication({
    runtime: middleware,
    repositories: options.repositories ?? defaultRepositoryManager,
    ws: {
      authorizeRoomMessage: createApiV1RoomWsAuthorizer(
        middleware.groupsRepository,
      ),
      ...options.ws,
    },
    appData: {
      repository: options.appDataRepository ??
        new PSqlAppDataRepository(sql as unknown as PSqlSql),
    },
    system: {
      installDefaultMiddlewareTopics: (runtime, ws) => {
        initRallarSystemWsTopics(runtime.wsQBoxServerService, {
          initDynamicTopics: false,
          rtcTopologyService,
          rtcTopologyOptions,
          rtcTopologyRuntimeState: {
            repository: runtimeStateRepository,
          },
          rtcTopologyAppInbox: {
            inboxQueueReader: runtime.inboxQueueReader,
            senderId: myServerId,
            wake: () => runtime.qboxEngine.wake(),
            findGroupSnapshotByRef: (ref, cacheOptions) =>
              groupSnapshotCache.findOrLoadByRef(ref, cacheOptions),
          },
        });
        installRallarCrdtWsTopics(ws, {
          logRepository: crdtLogRepository,
        });
      },
      installWebSocketLifecycle: (runtime) => {
        initSharedWsLifecycle(runtime.wsQBoxServerService, {
          disconnectClientSession: async (sessionId) => {
            const result = await getMiddleware().appClientInboxService
              .processAuthorisedWsClientDisconnect(
                sessionId,
              );
            result.fold(
              (error) => {
                throw new Error(error);
              },
              () => undefined,
            );
          },
          disconnectGroupSessionsBySessionId: async (
            sessionId,
            request,
          ) => {
            const result = await getMiddleware().appGroupInboxService
              .processPresenceDisconnectsBySessionId(
                sessionId,
                request,
              );
            result.fold(
              (error) => {
                throw new Error(error);
              },
              () => undefined,
            );
          },
        });
      },
    },
    routes: {
      ws: wsRoutes.init,
      rest: [
        configRoutes.init,
        iceRoutes.init,
        clientStateRoutes.init,
        groupStateRoutes.init,
        (app) =>
          spaStatisticsRoutes.init(app, {
            statistics: spaStatistics,
          }),
        (app) =>
          graphTopologyRoutes.init(app, {
            graphDiagnostics: {
              readScopedGlobalGraphDiagnostic,
              readGroupGraphDiagnostic,
            },
            topologyManagement,
            adminClientIds,
          }),
        graphRoutes.init,
        (app) =>
          crdtAdminRoutes.init(app, {
            repository: crdtLogRepository,
            audit: options.crdtAuditSink,
            adminClientIds,
          }),
        (app) =>
          adminOperationsRoutes.init(app, {
            adminClientIds,
            operations: adminOperations,
            now: rtcTopologyOptions.now ?? (() => Date.now()),
          }),
        (app) =>
          adminSupportRoutes.init(app, {
            adminClientIds,
            support: adminSupport,
          }),
        swaggerRoutes.init,
      ],
    },
  });
  return rallarApplication;
}

function readAdminClientIds(): readonly string[] {
  return (Deno.env.get('AUTH_ADMIN_CLIENT_IDS') ?? 'admin')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}
