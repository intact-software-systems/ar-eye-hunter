import type { Hono } from 'jsr:@hono/hono@4.11.9';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { defaultRepositoryManager } from '@shared/cache/defaultRepositoryManager.ts';
import type { AppDataRepositoryLike } from '@shared-server/app-data/AppDataRepository.ts';
import { installRallarCrdtWsTopics } from '@shared-server/crdt/RallarCrdtServer.ts';
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
import { initRallarSystemWsTopics } from '@shared-server/rallar-system/ws-system-topics.ts';
import type {
  RallarRtcTopologyServiceOptions,
} from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import {
  readGroupGraphDiagnostic,
  readScopedGlobalGraphDiagnostic,
} from '@shared-graph/graph-diagnostics-service.ts';
import type { RallarServerWsFacadeOptions } from '@shared-server/rallar-facade/ws-topic-router.ts';
import type { ApiV1Runtime } from './composition/api-v1-runtime.ts';
import {
  createApiV1AdminServices,
  readApiV1WebSocketStatus,
} from './composition/create-api-v1-admin-services.ts';
import { createApiV1TopologyServices } from './composition/create-api-v1-topology-services.ts';
import { initialiseMiddleware } from './initialise-middleware.ts';
import {
  getApiRtcTopologyServiceOptions,
  readApiGlobalGraphRecomputeLimit,
  readApiRtcRttRefinementGateConfig,
} from './services/rtc-topology-config.ts';
import { getApiTimingSink } from './services/timing-service.ts';
import { createApiV1RoomWsAuthorizer } from './services/ws-topic-room-authorizer.ts';
import { createCrdtWsMutationIngress } from './services/create-crdt-ws-mutation-ingress.ts';
import { readConfiguredCrdtPolicies } from './services/create-api-mutation-inbox-factories.ts';
import { createRallarAdminRouteInitializers } from './create-rallar-admin-route-initializers.ts';
import * as configRoutes from './routes/config-route.ts';
import * as wsRoutes from './routes/ws-routes.ts';
import * as iceRoutes from './routes/ice-route.ts';
import * as spaStatisticsRoutes from './routes/spa-statistics-routes.ts';
import * as graphTopologyRoutes from './routes/graph-topology-routes.ts';
import {
  createStateSnapshotReadRouteRegistrars,
} from './routes/create-state-snapshot-read-route-registrars.ts';
import * as swaggerRoutes from './routes/swagger-routes.ts';
import {
  initWsLifecycle as initSharedWsLifecycle,
  scheduleWsLifecycleRetry,
} from '@shared-server/rallar-system/services/ws-lifecycle-service.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
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
import { requireApiAuthSession, requireWsAuthSession } from './services/request-auth-service.ts';

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
  let stopSystemTopics: (() => void) | undefined;

  const snapshotReadRoutes = createStateSnapshotReadRouteRegistrars(middleware);
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
    system: {
      installDefaultMiddlewareTopics: (runtime, ws) => {
        stopSystemTopics?.();

        const systemTopics = initRallarSystemWsTopics(
          runtime.wsQBoxServerService,
          {
            initDynamicTopics: false,
            rtcTopologyService: topology.rtcTopologyService,
            rtcTopologyOptions: topology.rtcTopologyOptions,
            rtcTopologyManagement: topology.topologyManagement,
            rttRefinementGate: topology.rttRefinementGate,
            rttRefinementService: topology.rttRefinementService,
            observeGroupSnapshot: async (snapshot) => {
              await runtime.groupStateService.observeSnapshot(snapshot);
            },
            observeClientSnapshot: async (snapshot) => {
              await runtime.clientStateService.observeSnapshot(snapshot);
            },
            rtcTopologyRepositories: {
              topologyConfig: topology.topologyConfigRepository,
              groupState: topology.groupStateRepository,
              topologySnapshots: topology.topologySnapshotRepository,
              rtts: topology.rttRepository,
            },
            globalGraphRecomputeLimit: readApiGlobalGraphRecomputeLimit(),
            rtcTopologyAppOutbox: {
              database,
              outboxQueueReader: runtime.outboxQueueReader,
              senderId: myServerId,
              wake: () => runtime.qboxEngine.wake(),
              wakeReplay: () => runtime.rtcTopologyReplay.wake('local-commit'),
              executionRepository: runtime.rtcTopologyExecutionRepository,
              topologyDelivery: runtime.rtcTopologyDelivery,
              findGroupSnapshotByRef: (ref, cacheOptions) =>
                runtime.groupStateService.readSnapshotAtLeast(ref, cacheOptions ?? {}),
            },
            enqueueRtcRttMutation: (input) => middleware.appGroupInboxService.enqueueRtcRtt(input),
          },
        );

        const unregister = middleware.backgroundTasks.register(systemTopics.stop);
        stopSystemTopics = () => {
          unregister();
          systemTopics.stop();
        };
        if (!middleware.appCrdtInboxService) {
          throw new Error('CRDT websocket topics require AppInbox mutation ingress');
        }
        installRallarCrdtWsTopics(ws, {
          logRepository: crdtLogRepository,
          mutationIngress: createCrdtWsMutationIngress(
            middleware.appCrdtInboxService,
            myServerId,
          ),
          allowPrincipalDocuments: true,
          allowAppDocuments: true,
          policies: crdtPolicies,
        });
      },
      installWebSocketLifecycle: (runtime) => {
        const lifecycle = initSharedWsLifecycle(runtime.wsQBoxServerService, {
          now,
          enqueueClientSessionDisconnect: (input) =>
            runtime.appClientInboxService.enqueueAuthorisedWsClientDisconnect(
              wsRoutes.toAuthorisedWsClientDisconnectInput(input),
            ),
          enqueueGroupSessionCleanup: (input) =>
            runtime.appGroupInboxService.enqueueGroupSessionCleanup(
              wsRoutes.toGroupPresenceSessionCleanupInput(input),
            ),
          hasCloseFacts: wsRoutes.hasAuthorisedWsCloseFacts,
          releaseCloseFacts: wsRoutes.releaseAuthorisedWsCloseFacts,
          retry: {
            delaysMs: [
              ...DEFAULT_RESOURCE_INBOX_RETRY_POLICY.delaysAfterAttemptMs,
              DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxDelayMs,
            ],
            schedule: scheduleWsLifecycleRetry,
          },
        });
        middleware.backgroundTasks.register(lifecycle.stop);
      },
    },

    routes: {
      ws: (app) =>
        wsRoutes.registerWsRoutes(app, {
          socketServer: middleware.wsQBoxServerService.socket,
          appClientInboxService: middleware.appClientInboxService,
          requireWsAuthSession: (input) =>
            requireWsAuthSession(
              input,
              middleware.appAuthInboxService,
              {
                requestId: crypto.randomUUID(),
                capturedAtEpochMs: Date.now(),
              },
            ),
        }),

      rest: [
        (app) =>
          configRoutes.registerConfigRoutes(app, {
            requireApiAuthSession: (request) =>
              requireApiAuthSession(request, middleware.authSessionRepository),
            readEnv: (name) => Deno.env.get(name),
            now,
            createTokenId: () => crypto.randomUUID(),
            appAuthInbox: middleware.appAuthInboxService,
            authUserRepository,
            staticClients: readAuthorisedClients(Deno.env),
            registrationMode: readAuthRegistrationMode(Deno.env),
            adminClientIds: new Set(adminClientIds),
          }),

        (app) =>
          iceRoutes.registerIceRoutes(app, {
            requireApiAuthSession: (request) =>
              requireApiAuthSession(request, middleware.authSessionRepository),
          }),

        snapshotReadRoutes.client,
        snapshotReadRoutes.group,

        (app) =>
          spaStatisticsRoutes.registerSpaStatisticsRoutes(app, {
            statistics: admin.statistics,
            requireApiAuthSession: (request) =>
              requireApiAuthSession(request, middleware.authSessionRepository),
          }),

        (app) =>
          graphTopologyRoutes.registerGraphTopologyRoutes(app, {
            groupStateService: snapshotReadRoutes.graphGroupStateService,
            graphDiagnostics: {
              readScopedGlobalGraphDiagnostic,
              readGroupGraphDiagnostic,
            },
            topologyManagement: topology.topologyManagement,
            processTopologyAppInbox: (authority, enqueue) =>
              graphTopologyRoutes.processTopologyAppInbox(
                middleware.appGroupInboxService,
                authority,
                enqueue,
              ),
            requireApiAuthSession: (request) =>
              requireApiAuthSession(request, middleware.authSessionRepository),
            adminClientIds,
            now,
          }),

        ...createRallarAdminRouteInitializers({
          crdt: {
            repository: crdtLogRepository,
            mutations: middleware.appCrdtInboxService,
            audit: options.crdtAuditSink,
            adminClientIds,
            requireApiAdminSession: async (context) =>
              await requireApiAuthSession(
                context.req,
                middleware.authSessionRepository,
              ),
            requireApiUserSession: async (context) =>
              await requireApiAuthSession(
                context.req,
                middleware.authSessionRepository,
              ),
          },
          catchUpSnapshots: {
            readGroupSnapshot: (ref) => middleware.groupsRepository.readSnapshot(ref),
            readClientSnapshot: (ref) => middleware.clientsRepository.readSnapshot(ref),
            nowEpochMs: now,
          },
          operations: {
            adminClientIds,
            operations: admin.operations,
            now,
            requireApiAuthSession: (request) =>
              requireApiAuthSession(request, middleware.authSessionRepository),
          },
          support: {
            adminClientIds,
            support: admin.support,
            requireApiAuthSession: (request) =>
              requireApiAuthSession(request, middleware.authSessionRepository),
          },
        }),

        swaggerRoutes.init,
      ],
    },
  });
  return rallarApplication;
}

function readAuthRegistrationMode(
  env: Pick<Deno.Env, 'get'>,
): 'public' | 'admin' {
  return env.get('AUTH_REGISTRATION_MODE')?.trim().toLowerCase() === 'admin' ? 'admin' : 'public';
}
