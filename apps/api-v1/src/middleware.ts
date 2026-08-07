import { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
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
import { installQueueBoxPubSubBridge } from '@shared-server/rallar-system/pubsub/QueueBoxPubSubBridge.ts';
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
import { createClientStateService } from '@shared-server/rallar-system/services/client-state-service.ts';
import { createGroupStateService }
  from '@shared-server/rallar-system/services/group-state-service.ts';
import {
  createCachedClientStateService,
} from '@shared-server/rallar-system/services/cached-client-state-service.ts';
import {
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
import { createApiStateSnapshotReadSelectors, getApiAppInboxServiceOptions,
  getApiTimingSink } from './services/timing-service.ts';
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
  deriveRtcTopologyEntryResourceId,
  writeRtcTopologyOutbox,
} from '@shared-server/rallar-system/services/rtc-topology-outbox-entry.ts';
import {
  createRtcTopologyPublicationFanout,
} from '@shared-server/rallar-system/pubsub/RtcTopologyClusterTransport.ts';
import { createApiV1RtcTopologyClusterTransport } from './db/api-v1-rtc-topology-cluster-transport.ts';
import { type Middleware, requireApiMiddleware } from './middleware-contract.ts';
export type { Middleware };
let middleware: Middleware | undefined = undefined;
const runtimeStateExpiryLifecycle = createRuntimeStateExpiryLifecycle();
const middlewareBackgroundTaskStops = new Set<() => void>();
export function getMiddleware(): Middleware {
  if (middleware === undefined) throw new Error('Middleware not initialised');
  return middleware;
}
export function initialiseMiddleware() {
  shutdownMiddlewareBackgroundTasks();
  middleware = initialise(runtimeStateExpiryLifecycle.beginStartupGeneration());
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
  const authSessionRepository = createAuthSessionRepository(runtimeStateRepository);
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
    findClientSnapshotByRef: (ref) => findCurrentClientSnapshot(clientSnapshotReadThroughCache, ref),
    inboundStores: resolveServerWsQBoxALInboundRuntimeStores(wsRuntimeName),
    outboundStores: resolveServerWsQBoxALOutboundRuntimeStores(wsRuntimeName),
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
    rtcTopologyPublicationRepository,
    rtcTopologyExecutionRepository,
    rtcTopologyPublicationFanout,
    readiness: rtcTopologyPublicationFanout.readiness,
  });
  const scalarRecomputeWorker = initRtcTopologyScalarRecomputeWorker({
    runtime: runtimeStateRepository,
    process: async (groupRef, requestId) => {
      const groupSnapshot = await groupsRepository.readSnapshot(groupRef);
      if (!groupSnapshot) return 'group-absent-terminal';
      const createdAtEpochMs = now();
      const identity = {
        commandId: requestId,
        effectKind: 'rtc-topology-recompute' as const,
        payloadKind: 'group-revision' as const,
        acceptedCausalRevision: groupSnapshot.causalRevision,
      };
      await postgresSql.begin(async (transaction) => {
        await writeRtcTopologyOutbox(transaction, {
          ...identity,
          resourceId: deriveRtcTopologyEntryResourceId(identity),
          aggregateRef: groupRef,
          groupSnapshot,
          createdAtEpochMs,
          expireAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP,
          senderId: myServerId,
          requestOptions: toCanonicalGroupTopologyConfigPatch({}),
          publish: true,
        });
      });
      runtime.qboxEngine.wake();
      return 'enqueued';
    },
    onError: (error) => {
      console.error('Failed to drain RTC topology scalar recompute requests:', error);
    },
  });
  registerMiddlewareBackgroundTask(scalarRecomputeWorker.stop);
  void scalarRecomputeWorker.firstRun.catch(() => undefined);
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
  const selectors = createApiStateSnapshotReadSelectors({
    clientDurable: clientsRepository, clientCache: clientSnapshotReadThroughCache,
    groupDurable: groupsRepository, groupCache: groupSnapshotReadThroughCache,
  }, timing);
  return requireApiMiddleware(runtime, selectors);
}
function readRequiredAuthCredentialSecret(): string {
  const secret = Deno.env.get('RALLAR_AUTH_CREDENTIAL_SECRET')?.trim();
  if (!secret) throw new Error('RALLAR_AUTH_CREDENTIAL_SECRET is required');
  return secret;
}
