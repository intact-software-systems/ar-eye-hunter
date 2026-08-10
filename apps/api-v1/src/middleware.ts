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
} from '@shared-server/rallar-system/middleware/RallarMiddleware.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/services/AppClientInboxService.ts';
import { AppGroupInboxService } from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import { AppAuthInboxService } from '@shared-server/rallar-system/services/AppAuthInboxService.ts';
import {
  createApiCrdtMutationInboxFactories,
  findCurrentClientSnapshot,
} from './services/create-api-crdt-document-authorizer.ts';
import { createAuthMutationService } from '@shared-server/rallar-system/services/auth-state-mutations.ts';
import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/services/auth-credential-issuer.ts';
import { AppOutboxType } from '@shared-server/rallar-system/services/AppOutboxService.ts';
import {
  createAppInboxRetryExhaustionHandler,
  createAppInboxRetryExhaustionRecoveryHandler,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import { recordRallarTiming } from '@shared-server/rallar-system/services/timing.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/services/GroupPresenceSummaryWork.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts';
import {
  backfillAllGroupTopologyConfigGenerations,
} from '@shared-server/rallar-system/services/group-topology-config-generation-backfill.ts';
import { createClientStateService }
  from '@shared-server/rallar-system/services/client-state-service.ts';
import { createGroupStateService }
  from '@shared-server/rallar-system/services/group-state-service.ts';
import {
  createCachedClientStateService,
} from '@shared-server/rallar-system/services/cached-client-state-service.ts';
import {
  createCachedGroupStateService,
} from '@shared-server/rallar-system/services/cached-group-state-service.ts';
import { myPublisherId, myRtcTopologyStreamId, myServerId } from './runtime/runtime-identity.ts';
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
import { createApiStateSnapshotReadSelectors, getApiAppInboxServiceOptions,
  getApiTimingSink } from './services/timing-service.ts';
import { runRuntimeStateExpiryStartupBarrier } from './services/runtime-state-expiry-startup.ts';
import { readApiV1DatabasePubSubConfig } from './db/database-pubsub-config.ts';
import { readApiV1DatabaseBackendConfig } from './db/database-config.ts';
import {
  initRtcRttReceiptFamilyCleanup,
  RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES,
  RtcRttRepository,
} from '@shared-server/rallar-system/repositories/RtcRttRepository.ts';
import {
  setRtcTopologyOutboxWriteSink,
} from '@shared-server/rallar-system/services/rtc-topology-outbox-entry.ts';
import {
  createGroupFormationMetricsRecorder,
} from '@shared-server/rallar-system/formation-metrics/formation-metrics.ts';
import {
  initApiRtcTopologyScalarRecomputeWorker,
} from './services/init-api-rtc-topology-scalar-recompute-worker.ts';
import { type Middleware, requireApiMiddleware } from './middleware-contract.ts';
import {
  createApiRtcTopologyRuntime,
} from './runtime/rtc-topology/create-api-rtc-topology-runtime.ts';
import {
  readApiRtcTopologyReplayConfig,
} from './runtime/rtc-topology/rtc-topology-replay-config.ts';
import {
  beginMiddlewareStartupGeneration,
  registerMiddlewareBackgroundTask,
  shutdownMiddlewareBackgroundTasks,
} from './middleware-background-tasks.ts';
import {
  createApiRtcTopologyQueuePubSubBridge,
} from './runtime/rtc-topology/create-api-rtc-topology-queue-pub-sub-bridge.ts';
import {
  readAuthorisedWsConnectionIdentity,
} from './runtime/rtc-topology/authorised-ws-connection-registry.ts';

export type { Middleware };
export { registerMiddlewareBackgroundTask, shutdownMiddlewareBackgroundTasks };
let middleware: Middleware | undefined = undefined;
export function getMiddleware(): Middleware {
  if (middleware === undefined) throw new Error('Middleware not initialised');
  return middleware;
}
export function initialiseMiddleware() {
  void shutdownMiddlewareBackgroundTasks().catch((error) => {
    console.error('Failed to stop prior middleware background tasks:', error);
  });
  middleware = initialise(beginMiddlewareStartupGeneration());
  return middleware;
}
function initialise(
  expiryStartupGeneration: ReturnType<typeof beginMiddlewareStartupGeneration>,
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
  const groupFormationMetrics = createGroupFormationMetricsRecorder();
  setRtcTopologyOutboxWriteSink(groupFormationMetrics.topologyOutboxWritten);
  const databaseConfig = readApiV1DatabaseBackendConfig();
  const pubSubConfig = readApiV1DatabasePubSubConfig(Deno.env, databaseConfig);
  const rtcTopologyReplayConfig = readApiRtcTopologyReplayConfig(
    Deno.env,
    databaseConfig,
  );
  const groupSnapshotReadThroughCache = createGroupStateSnapshotReadThroughCache({
    groupsRepository,
  });
  const clientSnapshotReadThroughCache = createClientStateSnapshotReadThroughCache({
    clientsRepository,
  });
  const runtimeStateRepository = createRuntimeStateRepository(sql);
  const authSessionRepository = createAuthSessionRepository(runtimeStateRepository);
  const authCredentialSecret = Deno.env.get('RALLAR_AUTH_CREDENTIAL_SECRET')?.trim();
  if (!authCredentialSecret) throw new Error('RALLAR_AUTH_CREDENTIAL_SECRET is required');
  const credentialIssuer = createHmacAuthCredentialIssuer(authCredentialSecret);
  const rtcRttRepository = new RtcRttRepository(runtimeStateRepository, { now });
  const rtcTopology = createApiRtcTopologyRuntime({
    database: postgresSql,
    runtimeStateRepository,
    groupsRepository,
    webSocketServer,
    publisherStreamId: myRtcTopologyStreamId,
    nowEpochMs: now,
    onCompactionFailure: (error) => {
      console.error('RTC topology delivery compaction failed:', error);
    },
    replayMode: rtcTopologyReplayConfig.replay,
    readHydrationIdentity: readAuthorisedWsConnectionIdentity,
  });
  registerMiddlewareBackgroundTask(async () => await rtcTopology.stop());
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
    findClientSnapshotByRef: (ref) => findCurrentClientSnapshot(clientSnapshotReadThroughCache, ref),
    inboundStores: resolveServerWsQBoxALInboundRuntimeStores(wsRuntimeName),
    outboundStores: resolveServerWsQBoxALOutboundRuntimeStores(wsRuntimeName),
    wsDeliveryDiagnostics: groupFormationMetrics.wsDelivery,
    createAppGroupInboxService: ({
      inboxQueueReader,
      outboxQueueReader,
      wakeQueueEngine,
    }) => {
      const durable = createGroupStateService({
        runtimeRepository: runtimeStateRepository,
        authSessionRepository,
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
        formationMetrics: groupFormationMetrics.presenceSummary,
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
        groupFormationMetrics.groupMutation,
      );
    },
    createAppClientInboxService: ({ inboxQueueReader, wakeQueueEngine }) => {
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
        wakeQueueEngine,
      );
    },
    createAppAuthInboxService: ({ inboxQueueReader, wakeQueueEngine }) =>
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
        wakeQueueEngine,
      ),
    ...createApiCrdtMutationInboxFactories({
      database: postgresSql,
      serviceId: myServerId,
      timing,
      options: appInboxOptions,
      repositories: { authSessionRepository, groupsRepository, clientsRepository },
    }),
    resilience: {
      inbox: resilienceInbox,
      outbox: resilienceOutbox,
      appOutbox: resilienceAppOutbox,
    },
    clientsRepository,
    groupsRepository,
    rtcTopologyPublicationRepository: rtcTopology.publicationRepository,
    rtcTopologyExecutionRepository: rtcTopology.executionRepository,
    rtcTopologyDelivery: rtcTopology.topologyDelivery,
    rtcTopologyReplay: rtcTopology.topologyReplay,
    queuePubSubBridge: createApiRtcTopologyQueuePubSubBridge({
      config: pubSubConfig,
      channel: dbWsChannelId,
      publisherId: myPublisherId,
      timing,
      wakeReplay: () => rtcTopology.topologyReplay.wake('notification'),
    }),
    readiness: rtcTopology.readiness,
    healthFailure: rtcTopology.healthFailure,
  });
  rtcTopology.topologyReplay.attach({
    wsQueueBoxServerService: runtime.wsQBoxServerService,
  });
  const scalarRecomputeWorker = initApiRtcTopologyScalarRecomputeWorker({
    runtimeStateRepository,
    groupsRepository,
    database: postgresSql,
    serviceId: myServerId,
    now,
    wake: () => runtime.qboxEngine.wake(),
  });
  registerMiddlewareBackgroundTask(scalarRecomputeWorker.stop);
  void scalarRecomputeWorker.firstRun.catch(() => undefined);
  initPresenceExpiryReconciliation({
    appClientInboxService: runtime.appClientInboxService,
    appGroupInboxService: runtime.appGroupInboxService,
  })
    .catch((e) => console.error('Failed to initialise presence expiry reconciliation:', e));
  const selectors = createApiStateSnapshotReadSelectors({
    clientDurable: clientsRepository, clientCache: clientSnapshotReadThroughCache,
    groupDurable: groupsRepository, groupCache: groupSnapshotReadThroughCache,
  }, timing);
  return requireApiMiddleware(runtime, selectors, groupFormationMetrics);
}
