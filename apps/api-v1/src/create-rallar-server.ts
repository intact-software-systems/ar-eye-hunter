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
import { RallarServerDataFacade, RallarServerSystemFacade }
  from '@shared-server/rallar-facade/RallarServer.ts';
import { initRallarSystemWsTopics } from '@shared-server/rallar-system/ws-system-topics.ts';
import {
  RallarRtcTopologyService,
  type RallarRtcTopologyServiceOptions,
} from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import { AdminOperationsService } from '@shared-server/rallar-system/admin-operations/AdminOperationsService.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/\
persistence/group-topology-config-repository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
// prettier-ignore
import { RtcRttRepository }
  from '@shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-repository.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts';
import { GroupTopologyManagementService }
  from '@shared-server/rallar-system/topology/group-topology-management-service.ts';
import { PSqlAdminOperationsStatsReader }
  from '@shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts';
import { AdminSupportService } from '@shared-server/rallar-system/admin-support/AdminSupportService.ts';
import { PSqlAdminSupportReader } from '@shared-server/postgres/admin-support/PSqlAdminSupportReader.ts';
import { sendStateSyncMessage } from '@shared-server/rallar-system/state-sync-routing.ts';
import { readGroupGraphDiagnostic, readScopedGlobalGraphDiagnostic }
  from '@shared-graph/graph-diagnostics-service.ts';
import * as vivaldiService from '@shared-graph/vivaldi-service.ts';
import type { RallarServerWsFacadeOptions } from '@shared-server/rallar-facade/ws-topic-router.ts';
import type { Middleware } from './middleware-contract.ts';
import { initialiseMiddleware, registerMiddlewareBackgroundTask } from './middleware.ts';
import {
  getApiRtcTopologyServiceOptions,
  readApiRtcRttRefinementGateConfig,
} from './services/rtc-topology-config.ts';
// prettier-ignore
import {
  RtcRttRefinementGate,
} from '@shared-server/rallar-system/rtc-topology/topic/rtc-rtt-refinement-gate.ts';
import {
  RtcRttRefinementService,
} from '@shared-server/rallar-system/rtc-topology/topic/rtc-rtt-refinement-service.ts';
import { getApiTimingSink } from './services/timing-service.ts';
import { createApiV1RoomWsAuthorizer } from './services/ws-topic-room-authorizer.ts';
import { createCrdtWsMutationIngress } from './services/create-crdt-ws-mutation-ingress.ts';
import { createApiAdminMutationGateway } from './services/create-api-admin-mutation-gateway.ts';
import { readConfiguredCrdtPolicies } from './services/create-api-mutation-inbox-factories.ts';
import {
  createRallarAdminRouteInitializers,
} from './create-rallar-admin-route-initializers.ts';
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
import { readApiV1DatabaseBackendConfig } from './db/database-config.ts';
import { readApiV1DatabasePubSubConfig } from './db/database-pubsub-config.ts';
import { myServerId } from './runtime/runtime-identity.ts';
import { createRuntimeStateRepository } from './repository/createStateRepositories.ts';
import { SpaStatisticsService } from '@shared-server/rallar-system/spa-statistics/SpaStatisticsService.ts';
import { toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { createApiRtcTopologyAdminMetrics }
  from './runtime/rtc-topology/create-api-rtc-topology-admin-metrics.ts';
import { readAdminClientIds } from './services/read-admin-client-ids.ts';

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
  const crdtPolicies = readConfiguredCrdtPolicies();
  const middleware = options.middleware ?? initialiseMiddleware();

  const crdtLogRepository = options.crdtLogRepository ??
    new PSqlCrdtLogRepository(sql as unknown as PSqlSql, {
      serverId: myServerId,
      audit: options.crdtAuditSink,
      policies: crdtPolicies,
    });
  middleware.appCrdtInboxService?.setAuditSink(options.crdtAuditSink);

  const runtimeStateRepository = createRuntimeStateRepository(sql);
  const configuredRtcTopologyOptions = options.rtcTopologyOptions ??
    getApiRtcTopologyServiceOptions();
  const now = configuredRtcTopologyOptions.now ?? (() => Date.now());
  const timing = getApiTimingSink();
  const rtcTopologyOptions = {
    ...configuredRtcTopologyOptions,
    now,
  };
  const rtcTopologyServerDefaults = {
    ...rtcTopologyOptions,
    topologyKind: rtcTopologyOptions.topologyKind ?? 'auto' as const,
  };
  const rtcTopologyService = new RallarRtcTopologyService(rtcTopologyOptions);
  const rttRefinementGate = new RtcRttRefinementGate({
    ...readApiRtcRttRefinementGateConfig(),
  });
  const rttRefinementService = new RtcRttRefinementService({
    gate: rttRefinementGate,
    nowEpochMs: now,
    observeRtt: vivaldiService.observeRtt,
    readPredictedNodeData: vivaldiService.readablePredictedNodeData,
  });
  const topologyConfigRepository = new GroupTopologyConfigRepository(
    runtimeStateRepository,
  );
  const groupStateRepository = new GroupStateRepository(runtimeStateRepository);
  const topologySnapshotRepository = new RtcTopologySnapshotRepository(
    runtimeStateRepository,
  );
  const rttRepository = new RtcRttRepository(runtimeStateRepository, {
    now: rtcTopologyOptions.now,
  });
  const adminClientIds = readAdminClientIds();
  const rtcTopologyAdminMetrics = createApiRtcTopologyAdminMetrics({
    planning: rtcTopologyService,
    replay: middleware.rtcTopologyReplay,
  });

  const topologyManagement = new GroupTopologyManagementService({
    findGroupSnapshotByRef: (ref, cacheOptions) =>
      middleware.groupStateService.readSnapshotAtLeast(ref, cacheOptions ?? {}),
    groupStateRepository,
    configRepository: topologyConfigRepository,
    topologyService: rtcTopologyService,
    topologySnapshotRepository,
    rttRepository,
    publisher: (message) => {
      sendStateSyncMessage(middleware.wsQBoxServerService.socket, message);
    },
    serverDefaults: rtcTopologyServerDefaults,
    now,
    timing,
    serviceId: myServerId,
    adminPrincipalIds: new Set(adminClientIds),
  });
  middleware.appGroupInboxService.setTopologyManagementService(
    topologyManagement,
  );

  middleware.appGroupInboxService.setRtcRttAppInboxDependencies({
    repository: rttRepository,
    formationMetrics: middleware.groupFormationMetrics.rttMutation,
    readPolicyInputs: async (command) => {
      const sessionsByGroupKey = new Map<string, {
        ref: GroupRef;
        sessionIds: Set<string>;
      }>();
      for (const session of await groupStateRepository.listAllPresenceSessions()) {
        if (session.status !== 'active' || session.expiresAtEpochMs <= now()) {
          continue;
        }
        const key = toWebRtcGroupKey(session);
        const current = sessionsByGroupKey.get(key) ?? {
          ref: {
            applicationId: session.applicationId,
            workspaceId: session.workspaceId,
            groupId: session.groupId,
          },
          sessionIds: new Set<string>(),
        };
        current.sessionIds.add(session.sessionId);
        sessionsByGroupKey.set(key, current);
      }
      const groupRefs = [...sessionsByGroupKey.values()]
        .filter(({ sessionIds }) =>
          sessionIds.has(command.rtt.sessionIdFrom) &&
          sessionIds.has(command.rtt.sessionIdTo)
        )
        .map(({ ref }) => ref);
      const candidateGroups = (
        await Promise.all(
          groupRefs.map((ref) => middleware.groupStateService.readSnapshotAtLeast(ref, {})),
        )
      ).filter((snapshot) => snapshot !== undefined);
      const overlaySnapshotsByGroupKey = new Map();
      for (const group of candidateGroups) {
        const snapshot = await topologySnapshotRepository.findSnapshot(
          group.group,
        );
        if (snapshot) {
          overlaySnapshotsByGroupKey.set(
            toWebRtcGroupKey(group.group),
            snapshot,
          );
        }
      }
      return {
        candidateGroups,
        overlaySnapshotsByGroupKey,
        degreeLimit: rtcTopologyService.readRttReportingDegreeLimit(),
      };
    },
  });

  const databaseConfig = readApiV1DatabaseBackendConfig();
  const databasePubSubConfig = readApiV1DatabasePubSubConfig(Deno.env, databaseConfig);
  const emptyWsStatus = {
    transport: 'ws-server' as const,
    connectionCount: 0,
    openConnectionCount: 0,
    connectionIds: [],
    openConnectionIds: [],
    connections: [],
  };
  if (!middleware.appAdminInboxService || !middleware.appCrdtInboxService) {
    throw new Error('Admin database mutations require AppInbox services');
  }

  const adminOperations: AdminOperationsService = new AdminOperationsService({
    now,
    serverId: myServerId,
    statsReader: new PSqlAdminOperationsStatsReader(sql as unknown as PSqlSql, {
      now,
      serverId: myServerId,
      sqlBackend: databaseConfig.sqlBackend,
      dbPubSub: databasePubSubConfig.mode,
    }),
    wsStatus: () => rallarApplication?.ws.status() ?? emptyWsStatus,
    readRtcTopologyMetrics: rtcTopologyAdminMetrics.read,
    resetRtcTopologyMetrics: rtcTopologyAdminMetrics.reset,
    readGroupFormationMetrics: () => middleware.groupFormationMetrics.readMetrics(),
    resetGroupFormationMetrics: () => middleware.groupFormationMetrics.resetMetrics(),
    crdtAdminRepository: crdtLogRepository,
    mutationGateway: createApiAdminMutationGateway({
      appAdmin: middleware.appAdminInboxService,
      appCrdt: middleware.appCrdtInboxService,
      appGroup: middleware.appGroupInboxService,
      now,
    }),
    timing,
  });
  const adminSupport: AdminSupportService = new AdminSupportService({
    now,
    serverId: myServerId,
    reader: new PSqlAdminSupportReader(sql as unknown as PSqlSql),
    clientStateService: middleware.clientStateService,
    groupStateService: middleware.groupStateService,
    topologyManagement,
    wsStatus: () => rallarApplication?.ws.status() ?? emptyWsStatus,
    crdtAdminRepository: crdtLogRepository,
    timing,
  });
  const spaStatistics = new SpaStatisticsService({
    now,
    clientStateService: middleware.clientStateService,
    groupStateService: middleware.groupStateService,
    wsStatus: () => rallarApplication?.ws.status() ?? emptyWsStatus,
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
        new PSqlAppDataRepository(sql as unknown as PSqlSql),
    },
    system: {
      installDefaultMiddlewareTopics: (runtime, ws) => {
        stopSystemTopics?.();

        const systemTopics = initRallarSystemWsTopics(
          runtime.wsQBoxServerService,
          {
            initDynamicTopics: false,
            rtcTopologyService,
            rtcTopologyOptions,
            rtcTopologyManagement: topologyManagement,
            rttRefinementGate,
            rttRefinementService,
            observeGroupSnapshot: async (snapshot) => {
              await runtime.groupStateService.observeSnapshot(snapshot);
            },
            observeClientSnapshot: async (snapshot) => {
              await runtime.clientStateService.observeSnapshot(snapshot);
            },
            rtcTopologyRepositories: {
              topologyConfig: topologyConfigRepository,
              groupState: groupStateRepository,
              topologySnapshots: topologySnapshotRepository,
              rtts: rttRepository,
            },
            rtcTopologyAppOutbox: {
              database: sql as unknown as PSqlSql,
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

        const unregister = registerMiddlewareBackgroundTask(systemTopics.stop);
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
        registerMiddlewareBackgroundTask(lifecycle.stop);
      },
    },

    routes: {
      ws: wsRoutes.init,
      rest: [
        configRoutes.init,
        iceRoutes.init,
        snapshotReadRoutes.client,
        snapshotReadRoutes.group,
        (app) =>
          spaStatisticsRoutes.init(app, {
            statistics: spaStatistics,
          }),
        (app) =>
          graphTopologyRoutes.init(app, {
            getGroupStateService: () => snapshotReadRoutes.graphGroupStateService,
            graphDiagnostics: {
              readScopedGlobalGraphDiagnostic,
              readGroupGraphDiagnostic,
            },
            topologyManagement,
            adminClientIds,
          }),
        ...createRallarAdminRouteInitializers({
          crdt: {
            repository: crdtLogRepository,
            mutations: middleware.appCrdtInboxService,
            audit: options.crdtAuditSink,
            adminClientIds,
          },
          catchUpSnapshots: {
            readGroupSnapshot: (ref) => middleware.groupsRepository.readSnapshot(ref),
            readClientSnapshot: (ref) => middleware.clientsRepository.readSnapshot(ref),
            nowEpochMs: now,
          },
          operations: { adminClientIds, operations: adminOperations, now },
          support: { adminClientIds, support: adminSupport },
        }),
        swaggerRoutes.init,
      ],
    },
  });
  return rallarApplication;
}
