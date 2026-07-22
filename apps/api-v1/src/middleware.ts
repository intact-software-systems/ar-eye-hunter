import { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import {
  initResourceInboxExpiryEviction,
  ResourceInboxRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import {
  ResourceInboxResultsRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import {
  initRuntimeStateExpiryEviction,
  PSqlRuntimeStateRepository,
} from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import {
  configureServerWsQBoxALRuntimeStores,
  resolveServerWsQBoxALInboundRuntimeStores,
  resolveServerWsQBoxALOutboundRuntimeStores,
} from '@shared-server/postgres/al-runtime/createPSqlALRuntimeStores.ts';
import {
  createRallarMiddleware,
  type RallarMiddlewareRuntime,
} from '@shared-server/rallar-system/middleware/RallarMiddleware.ts';
import { installQueueBoxPubSubBridge } from '@shared-server/rallar-system/pubsub/QueueBoxPubSubBridge.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/services/AppClientInboxService.ts';
import { AppGroupInboxService } from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import { createAppInboxRetryExhaustionHandler } from '@shared-server/rallar-system/services/AppInboxService.ts';
import { recordRallarTiming } from '@shared-server/rallar-system/services/timing.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/services/GroupPresenceSummaryWork.ts';
import { createRtcTopologyOutboxPublisher } from '@shared-server/rallar-system/services/RtcTopologyOutboxWork.ts';
import { StateMutationOutboxRepository } from '@shared-server/rallar-system/repositories/StateMutationOutboxRepository.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts';
import {
  backfillAllGroupTopologyConfigGenerations,
} from '@shared-server/rallar-system/services/group-topology-config-generation-backfill.ts';
import { createClientStateService } from '@shared-server/rallar-system/services/client-state-service.ts';
import {
  createGroupStateRuntime,
  type GroupStateMaintenanceService,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import {
  type CachedClientStateService,
  createCachedClientStateService,
} from '@shared-server/rallar-system/services/cached-client-state-service.ts';
import {
  type CachedGroupStateService,
  createCachedGroupStateService,
} from '@shared-server/rallar-system/services/cached-group-state-service.ts';
import { createWsStateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';
import { myPublisherId, myServerId } from './runtime/runtime-identity.ts';
import { toResilienceDto } from './middleware-resilience.ts';
import {
  createAuthSessionRepository,
  createClientStateEventRepository,
  createClientStateRepository,
  createGroupStateEventRepository,
  createGroupStateRepository,
  createRuntimeStateRepository,
} from './repository/createStateRepositories.ts';
import { sql } from './db/db.ts';
import {
  createGroupStateSnapshotReadThroughCache,
} from '@shared-server/rallar-system/services/group-state-snapshot-read-through-cache.ts';
import {
  createClientStateSnapshotReadThroughCache,
} from '@shared-server/rallar-system/services/client-state-snapshot-read-through-cache.ts';
import {
  initPresenceExpiryReconciliation,
} from '@shared-server/rallar-system/services/presence-expiry-reconciliation-service.ts';
import { getApiAppInboxServiceOptions, getApiTimingSink } from './services/timing-service.ts';
import {
  createRuntimeStateExpiryLifecycle,
  runRuntimeStateExpiryStartupBarrier,
} from './services/runtime-state-expiry-startup.ts';
import { readApiV1DatabasePubSubConfig } from './db/database-pubsub-config.ts';
import {
  createApiV1QueuePubSubBridge,
  queuePubSubDeliveryForConfig,
  shouldInstallQueuePubSubBridge,
} from './db/api-v1-queue-pubsub-bridge.ts';
import {
  DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS,
  RtcTopologyPublicationRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts';
import {
  initRtcRttReceiptFamilyCleanup,
  RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES,
  RtcRttRepository,
} from '@shared-server/rallar-system/repositories/RtcRttRepository.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts';
import {
  initRtcTopologyScalarRecomputeWorker,
} from '@shared-server/rallar-system/repositories/RtcTopologyScalarAuthorityMigration.ts';
import {
  createRtcTopologyPublicationFanout,
  type RtcTopologyPublicationFanout,
} from '@shared-server/rallar-system/pubsub/RtcTopologyClusterTransport.ts';
import { createApiV1RtcTopologyClusterTransport } from './db/api-v1-rtc-topology-cluster-transport.ts';

export type Middleware =
  & Omit<
    RallarMiddlewareRuntime,
    | 'clientStateService'
    | 'groupStateService'
    | 'rtcTopologyPublicationRepository'
    | 'rtcTopologyExecutionRepository'
    | 'rtcTopologyPublicationFanout'
  >
  & Readonly<{
    clientStateService: CachedClientStateService;
    groupStateService: CachedGroupStateService;
    rtcTopologyPublicationRepository: RtcTopologyPublicationRepository;
    rtcTopologyExecutionRepository: RtcTopologyExecutionRepository;
    rtcTopologyPublicationFanout: RtcTopologyPublicationFanout;
  }>;

let middleware: Middleware | undefined = undefined;
let groupStateMaintenanceService: GroupStateMaintenanceService | undefined;
const runtimeStateExpiryLifecycle = createRuntimeStateExpiryLifecycle();
const middlewareBackgroundTaskStops = new Set<() => void>();

export function getMiddleware(): Middleware {
  if (middleware === undefined) {
    throw new Error('Middleware not initialised');
  }
  return middleware;
}

export function getGroupStateMaintenanceService(): GroupStateMaintenanceService {
  if (groupStateMaintenanceService === undefined) {
    throw new Error('Group state maintenance service not initialised');
  }
  return groupStateMaintenanceService;
}

export function initialiseMiddleware() {
  shutdownMiddlewareBackgroundTasks();
  const expiryStartupGeneration = runtimeStateExpiryLifecycle
    .beginStartupGeneration();
  middleware = initialise(expiryStartupGeneration);
  return middleware;
}

export function shutdownMiddlewareBackgroundTasks(): void {
  const stops = [...middlewareBackgroundTaskStops];
  middlewareBackgroundTaskStops.clear();
  for (const stop of stops) stop();
  runtimeStateExpiryLifecycle.stop();
}

export function registerMiddlewareBackgroundTask(stop: () => void): () => void {
  middlewareBackgroundTaskStops.add(stop);
  return () => middlewareBackgroundTaskStops.delete(stop);
}

function initialise(
  expiryStartupGeneration: ReturnType<
    typeof runtimeStateExpiryLifecycle.beginStartupGeneration
  >,
): Middleware {
  const dbWsChannelId = 'ws-channel';
  const wsRuntimeName = 'default-qbox-server';
  const postgresSql = sql as unknown as PSqlSql;
  const resourceInboxRepository = new ResourceInboxRepository(postgresSql);
  const resourceInboxResultsRepository = new ResourceInboxResultsRepository(postgresSql);
  const queueBox = new PSqlQueueBox(resourceInboxRepository);
  const webSocketServer = new JsonWebSocketServer();
  const resilienceInbox = toResilienceDto();
  const resilienceOutbox = toResilienceDto();
  const resilienceAppOutbox = toResilienceDto();
  const clientsRepository = createClientStateRepository(sql);
  const groupsRepository = createGroupStateRepository(sql);
  const timing = getApiTimingSink();
  const now = () => Date.now();
  const appInboxOptions = getApiAppInboxServiceOptions();
  const pubSubConfig = readApiV1DatabasePubSubConfig();
  const groupSnapshotReadThroughCache = createGroupStateSnapshotReadThroughCache({
    groupsRepository,
  });
  const clientSnapshotReadThroughCache = createClientStateSnapshotReadThroughCache({
    clientsRepository,
  });
  const runtimeStateRepository = createRuntimeStateRepository(sql);
  const rtcRttRepository = new RtcRttRepository(runtimeStateRepository, { now });
  const rtcTopologyPublicationRepository = new RtcTopologyPublicationRepository(
    runtimeStateRepository,
    DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS,
    now,
  );
  const rtcTopologyExecutionRepository = new RtcTopologyExecutionRepository(
    runtimeStateRepository,
    DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS,
    now,
  );
  const rtcTopologyPublicationFanout = createRtcTopologyPublicationFanout({
    publisherId: myPublisherId,
    repository: rtcTopologyPublicationRepository,
    transport: createApiV1RtcTopologyClusterTransport(
      pubSubConfig,
      myPublisherId,
    ),
    server: webSocketServer,
  });

  configureServerWsQBoxALRuntimeStores(wsRuntimeName, { sql: postgresSql });
  initResourceInboxExpiryEviction(queueBox.repo).catch((e) =>
    console.error('Failed to initialise resource inbox expiry eviction:', e)
  );
  runRuntimeStateExpiryStartupBarrier({
    backfillTopologyGenerations: () =>
      backfillAllGroupTopologyConfigGenerations(
        new GroupTopologyConfigRepository(runtimeStateRepository),
      ),
    initialiseRtcRttReceiptFamilyCleanup: async () => {
      await expiryStartupGeneration.startRtcRttReceiptFamilyCleanup(() =>
        initRtcRttReceiptFamilyCleanup(rtcRttRepository, {
          onError: (error) => {
            console.error('RTC RTT receipt family cleanup failed:', error);
          },
        })
      );
    },
    isCurrentGeneration: expiryStartupGeneration.isCurrent,
    onDetachedRuntimeStateExpiryEvictionFailure: (error) => {
      console.error('Protected generic runtime-state expiry eviction failed:', error);
    },
    initialiseRuntimeStateExpiryEviction: () =>
      expiryStartupGeneration.startRuntimeStateExpiryEviction(() =>
        initRuntimeStateExpiryEviction(
          new PSqlRuntimeStateRepository(postgresSql),
          {
            excludedNamespaces: RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES,
          },
        )
      ),
    onGenerationsBackfilled: (advanced) => {
      if (advanced > 0) {
        console.log(`Backfilled group topology config generations: ${advanced}`);
      }
    },
  }).catch((e) =>
    console.error(
      'Failed to backfill topology generations or initialise runtime state expiry eviction:',
      e,
    )
  );

  const runtime = createRallarMiddleware({
    inbox: queueBox,
    outbox: queueBox,
    appInboxDequeueOptions: {
      nowEpochMs: now,
      onRetryExhausted: createAppInboxRetryExhaustionHandler({
        database: postgresSql,
        nowEpochMs: now,
        timing,
      }),
      onRetryExhaustionTelemetry: (exhaustion) => {
        recordRallarTiming(
          timing,
          {
            component: 'app-inbox-handler',
            operation: 'retry-exhaustion',
            requestId: exhaustion.entry.key.resourceId,
            details: {
              attempt: exhaustion.attempt,
              selectedLane: exhaustion.lane,
              classification: exhaustion.classification,
              exhaustion: exhaustion.exhausted,
              queueAgeMs: exhaustion.queueAgeMs,
              dueAgeMs: exhaustion.dueAgeMs,
            },
          },
          'ok',
          0,
        );
      },
    },
    webSocketServer,
    wsRuntimeName,
    findGroupSnapshotByRef: (ref) => groupSnapshotReadThroughCache.findByRef(ref),
    inboundStores: resolveServerWsQBoxALInboundRuntimeStores(wsRuntimeName),
    outboundStores: resolveServerWsQBoxALOutboundRuntimeStores(wsRuntimeName),
    createAppGroupInboxService: ({
      inboxQueueReader,
      wakeQueueEngine,
    }) => {
      const durableRuntime = createGroupStateRuntime({
        runtimeRepository: runtimeStateRepository,
        authSessionRepository: createAuthSessionRepository(runtimeStateRepository),
        createGroupStateEventStore: createGroupStateEventRepository,
        serviceId: myServerId,
        wakeStateMutationOutbox: wakeQueueEngine,
        timing,
      });
      groupStateMaintenanceService = durableRuntime.maintenance;
      const groupStateService = createCachedGroupStateService({
        durable: durableRuntime.service,
        cache: groupSnapshotReadThroughCache,
      });
      return new AppGroupInboxService(
        inboxQueueReader,
        resourceInboxRepository,
        resourceInboxResultsRepository,
        postgresSql,
        groupStateService,
        myServerId,
        timing,
        appInboxOptions,
      );
    },
    createAppClientInboxService: ({ inboxQueueReader, wsQBoxServerService }) => {
      const stateSyncPublisher = createWsStateSyncPublisher(
        wsQBoxServerService,
        { serverId: myServerId, timing },
      );
      const clientStateService = createCachedClientStateService({
        durable: createClientStateService({
          runtimeRepository: runtimeStateRepository,
          createClientStateEventStore: createClientStateEventRepository,
          syncPublisher: stateSyncPublisher,
          serviceId: myServerId,
          timing,
        }),
        cache: clientSnapshotReadThroughCache,
      });
      return new AppClientInboxService(
        inboxQueueReader,
        resourceInboxRepository,
        resourceInboxResultsRepository,
        postgresSql,
        clientStateService,
        stateSyncPublisher,
        myServerId,
        timing,
        appInboxOptions,
      );
    },
    resilience: {
      inbox: resilienceInbox,
      outbox: resilienceOutbox,
      appOutbox: resilienceAppOutbox,
    },
    clientsRepository,
    groupsRepository,
    stateMutationOutbox: ({ outboxQueueReader, wakeQueueEngine }) => {
      const topologyOutbox = createRtcTopologyOutboxPublisher({
        outboxQueueReader,
        senderId: myServerId,
        wake: wakeQueueEngine,
        now,
      });
      const scalarRecomputeWorker = initRtcTopologyScalarRecomputeWorker({
        runtime: runtimeStateRepository,
        process: async (groupRef, requestId) => {
          const group = await groupsRepository.readSnapshot(groupRef);
          // A missing authoritative group aggregate is terminal: without it no
          // current membership/presence topology can be computed or published.
          if (!group) return 'group-absent-terminal';
          await topologyOutbox.publisher.enqueueForStateMutation(group, requestId);
          return 'enqueued';
        },
        onError: (error) => {
          console.error('Failed to drain RTC topology scalar recompute requests:', error);
        },
      });
      registerMiddlewareBackgroundTask(scalarRecomputeWorker.stop);
      void scalarRecomputeWorker.firstRun.catch(() => undefined);
      return {
        repository: new StateMutationOutboxRepository(runtimeStateRepository),
        readClientSnapshot: (ref) => clientsRepository.readSnapshot(ref),
        readGroupSnapshot: (ref) => groupsRepository.readSnapshot(ref),
        groupPresenceSummaryPublisher: new GroupPresenceSummaryWork({
          runtimeRepository: runtimeStateRepository,
          serviceId: myServerId,
          wakeStateMutationOutbox: wakeQueueEngine,
          now,
          timing,
        }),
        rtcTopologyPublisher: topologyOutbox.publisher,
        stateSyncServerId: myServerId,
        senderId: myServerId,
        now,
        timing,
      };
    },
    rtcTopologyPublicationRepository,
    rtcTopologyExecutionRepository,
    rtcTopologyPublicationFanout,
    readiness: rtcTopologyPublicationFanout.readiness,
  });

  if (shouldInstallQueuePubSubBridge(pubSubConfig)) {
    installQueueBoxPubSubBridge({
      wsQBoxServerService: runtime.wsQBoxServerService,
      bridge: createApiV1QueuePubSubBridge(pubSubConfig, myPublisherId),
      channel: dbWsChannelId,
      publisherId: myPublisherId,
      delivery: queuePubSubDeliveryForConfig(pubSubConfig),
      timing,
    });
  }

  initPresenceExpiryReconciliation({
    appClientInboxService: runtime.appClientInboxService,
    groupStateMaintenanceService: getGroupStateMaintenanceService(),
  })
    .catch((e) => console.error('Failed to initialise presence expiry reconciliation:', e));

  return requireApiMiddleware(runtime);
}

function requireApiMiddleware(runtime: RallarMiddlewareRuntime): Middleware {
  if (!isCachedClientStateService(runtime.clientStateService)) {
    throw new Error('API middleware requires the cached client state service');
  }
  if (!isCachedGroupStateService(runtime.groupStateService)) {
    throw new Error('API middleware requires the cached group state service');
  }
  if (!runtime.rtcTopologyPublicationRepository) {
    throw new Error('API middleware requires the RTC topology publication repository');
  }
  if (!runtime.rtcTopologyExecutionRepository) {
    throw new Error('API middleware requires the RTC topology execution repository');
  }
  if (!runtime.rtcTopologyPublicationFanout) {
    throw new Error('API middleware requires the RTC topology publication fanout');
  }

  return {
    ...runtime,
    clientStateService: runtime.clientStateService,
    groupStateService: runtime.groupStateService,
    rtcTopologyPublicationRepository: runtime.rtcTopologyPublicationRepository,
    rtcTopologyExecutionRepository: runtime.rtcTopologyExecutionRepository,
    rtcTopologyPublicationFanout: runtime.rtcTopologyPublicationFanout,
  };
}

function isCachedClientStateService(
  service: RallarMiddlewareRuntime['clientStateService'],
): service is CachedClientStateService {
  return 'observeSnapshot' in service;
}

function isCachedGroupStateService(
  service: RallarMiddlewareRuntime['groupStateService'],
): service is CachedGroupStateService {
  return 'readCurrentSnapshot' in service;
}
