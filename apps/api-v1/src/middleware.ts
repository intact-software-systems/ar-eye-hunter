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
import { AppAuthInboxService } from '@shared-server/rallar-system/services/AppAuthInboxService.ts';
import { createAuthMutationService } from '@shared-server/rallar-system/services/auth-state-mutations.ts';
import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/services/auth-credential-issuer.ts';
import { AppOutboxType } from '@shared-server/rallar-system/services/AppOutboxService.ts';
import {
  createAppInboxRetryExhaustionHandler,
  createAppInboxRetryExhaustionRecoveryHandler,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
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
  createGroupStateService,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import {
  type CachedClientStateService,
  createCachedClientStateService,
} from '@shared-server/rallar-system/services/cached-client-state-service.ts';
import {
  type CachedGroupStateService,
  createCachedGroupStateService,
} from '@shared-server/rallar-system/services/cached-group-state-service.ts';
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
    | 'appAuthInboxService'
  >
  & Readonly<{
    clientStateService: CachedClientStateService;
    groupStateService: CachedGroupStateService;
    rtcTopologyPublicationRepository: RtcTopologyPublicationRepository;
    rtcTopologyExecutionRepository: RtcTopologyExecutionRepository;
    rtcTopologyPublicationFanout: RtcTopologyPublicationFanout;
    appAuthInboxService: AppAuthInboxService;
  }>;

let middleware: Middleware | undefined = undefined;
const runtimeStateExpiryLifecycle = createRuntimeStateExpiryLifecycle();
const middlewareBackgroundTaskStops = new Set<() => void>();

export function getMiddleware(): Middleware {
  if (middleware === undefined) {
    throw new Error('Middleware not initialised');
  }
  return middleware;
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
  const credentialIssuer = createHmacAuthCredentialIssuer(
    readRequiredAuthCredentialSecret(),
  );
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
        timing,
      }),
      onRetryExhaustionRecovery: createAppInboxRetryExhaustionRecoveryHandler({
        database: postgresSql,
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
              processingAttempts: exhaustion.processingAttempts,
              reservationAttempt: exhaustion.reservationAttempt,
              selectedLane: exhaustion.lane,
              classification: exhaustion.classification,
              exhaustion: exhaustion.exhausted,
              source: exhaustion.failure.source,
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
      outboxQueueReader,
      wakeQueueEngine,
    }) => {
      const durable = createGroupStateService({
        runtimeRepository: runtimeStateRepository,
        authSessionRepository: createAuthSessionRepository(runtimeStateRepository),
        createGroupStateEventStore: createGroupStateEventRepository,
        serviceId: myServerId,
        timing,
      });
      const groupStateService = createCachedGroupStateService({
        durable,
        cache: groupSnapshotReadThroughCache,
      });
      const presenceSummary = new GroupPresenceSummaryWork({
        runtimeRepository: runtimeStateRepository,
        database: postgresSql,
        serviceId: myServerId,
        wakeQueue: wakeQueueEngine,
        now,
        timing,
      });
      outboxQueueReader.onOutboxMessageDo(
        AppOutboxType.GROUP_PRESENCE_SUMMARY,
        {
          onMessage: async (message, entry) =>
            await presenceSummary.processReservedEntry(message, entry),
        },
      );
      return new AppGroupInboxService(
        inboxQueueReader,
        resourceInboxRepository,
        resourceInboxResultsRepository,
        postgresSql,
        groupStateService,
        myServerId,
        timing,
        appInboxOptions,
        wakeQueueEngine,
      );
    },
    createAppClientInboxService: ({ inboxQueueReader }) => {
      const clientStateService = createCachedClientStateService({
        durable: createClientStateService({
          runtimeRepository: runtimeStateRepository,
          createClientStateEventStore: createClientStateEventRepository,
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
        myServerId,
        timing,
        appInboxOptions,
      );
    },
    createAppAuthInboxService: ({ inboxQueueReader }) =>
      new AppAuthInboxService(
        inboxQueueReader,
        resourceInboxRepository,
        resourceInboxResultsRepository,
        postgresSql,
        createAuthMutationService({
          runtimeRepository: runtimeStateRepository,
          serviceId: myServerId,
        }),
        credentialIssuer,
        myServerId,
        timing,
        appInboxOptions,
      ),
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
    appGroupInboxService: runtime.appGroupInboxService,
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
  if (!runtime.appAuthInboxService) {
    throw new Error('API middleware requires the auth AppInbox service');
  }

  return {
    ...runtime,
    clientStateService: runtime.clientStateService,
    groupStateService: runtime.groupStateService,
    rtcTopologyPublicationRepository: runtime.rtcTopologyPublicationRepository,
    rtcTopologyExecutionRepository: runtime.rtcTopologyExecutionRepository,
    rtcTopologyPublicationFanout: runtime.rtcTopologyPublicationFanout,
    appAuthInboxService: runtime.appAuthInboxService,
  };
}

function readRequiredAuthCredentialSecret(): string {
  const secret = Deno.env.get('RALLAR_AUTH_CREDENTIAL_SECRET')?.trim();
  if (!secret) {
    throw new Error('RALLAR_AUTH_CREDENTIAL_SECRET is required');
  }
  return secret;
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
