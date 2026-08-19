import type { RallarCrdtDocumentTypePolicy } from '@shared/crdt/mod.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import {
  configureServerWsQBoxALRuntimeStores,
  resolveServerWsQBoxALInboundRuntimeStores,
  resolveServerWsQBoxALOutboundRuntimeStores,
} from '@shared-server/postgres/al-runtime/createPSqlALRuntimeStores.ts';
import {
  initResourceInboxExpiryEviction,
} from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import {
  initRuntimeStateExpiryEviction,
  PSqlRuntimeStateRepository,
} from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import {
  createRallarMiddleware,
  type RallarMiddlewareRuntime,
} from '@shared-server/rallar-system/middleware/RallarMiddleware.ts';
import {
  initPresenceExpiryReconciliation,
} from '@shared-server/rallar-system/services/presence-expiry-reconciliation-service.ts';
import type {
  AppInboxServiceOptions,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import { type RallarTimingSink } from '@shared-server/rallar-system/services/timing.ts';
import {
  GroupTopologyConfigRepository,
} from '@shared-server/rallar-system/topology/config/persistence/\
group-topology-config-repository.ts';
import * as generationBackfill from '@shared-server/rallar-system/topology/config/maintenance/\
backfill-group-topology-config-generations.ts';
import {
  initRtcRttReceiptFamilyCleanup,
} from '@shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-receipt-cleanup.ts';
import {
  RtcRttRepository,
} from '@shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-repository.ts';
import {
  RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES,
} from '@shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-runtime-namespaces.ts';
import {
  setRtcTopologyOutboxWriteSink,
} from '@shared-server/rallar-system/services/rtc-topology-outbox-entry.ts';

import type { ApiV1DatabasePubSubConfig } from '../db/database-pubsub-config.ts';
import type { ApiGroupCapacityConfig } from '../runtime/group-formation/group-capacity-config.ts';
import type {
  GroupFormationDampingMode,
} from '../runtime/group-formation/group-formation-damping-config.ts';
import type {
  GroupStateDisseminationMode,
} from '@shared-server/rallar-system/group-state/presence/group-presence-summary-work.ts';
import {
  createApiRtcTopologyQueuePubSubBridge,
} from '../runtime/rtc-topology/create-api-rtc-topology-queue-pub-sub-bridge.ts';
import {
  type ApiRtcTopologyRuntime,
  createApiRtcTopologyRuntime,
  type CreateApiRtcTopologyRuntimeInput,
} from '../runtime/rtc-topology/create-api-rtc-topology-runtime.ts';
import type { RtcTopologyReplayMode } from '../runtime/rtc-topology/rtc-topology-replay-config.ts';
import {
  readAuthorisedWsConnectionIdentity,
} from '../runtime/rtc-topology/authorised-ws-connection-registry.ts';
import { findCurrentClientSnapshot } from '../crdt/create-api-crdt-document-authorizer.ts';
import {
  type ApiStateSnapshotReadSelectors,
  createApiStateSnapshotReadSelectors,
} from '../services/create-api-state-snapshot-read-selectors.ts';
import {
  initApiRtcTopologyScalarRecomputeWorker,
} from '../services/init-api-rtc-topology-scalar-recompute-worker.ts';
import {
  runRuntimeStateExpiryStartupBarrier,
  type RuntimeStateExpiryStartupGeneration,
} from '../services/runtime-state-expiry-startup.ts';
import type { ApiV1BackgroundTaskLifecycle } from './api-v1-background-task-lifecycle.ts';
import { type ApiV1Runtime, requireApiV1Runtime } from './api-v1-runtime.ts';
import {
  type ApiV1MutationRuntime,
  createApiV1MutationRuntime,
  type CreateApiV1MutationRuntimeInput,
} from './create-api-v1-mutation-runtime.ts';

export interface CreateApiV1RuntimeInput {
  readonly database: PSqlSql;
  readonly serviceId: string;
  readonly publisherStreamId: string;
  readonly queuePubSubPublisherId: string;
  readonly queuePubSubChannel: string;
  readonly wsRuntimeName: string;
  readonly authCredentialSecret: string;
  readonly nowEpochMs: () => number;
  readonly timing: RallarTimingSink;
  readonly appInboxOptions: AppInboxServiceOptions;
  readonly clientFormationDamping: GroupFormationDampingMode;
  readonly groupCapacity: ApiGroupCapacityConfig;
  readonly groupStateDissemination: GroupStateDisseminationMode;
  readonly createGroupFormationTopologyIntent:
    CreateApiV1MutationRuntimeInput['createGroupFormationTopologyIntent'];
  readonly databasePubSub: ApiV1DatabasePubSubConfig;
  readonly rtcTopologyReplayMode: RtcTopologyReplayMode;
  readonly adminClientIds: readonly string[];
  readonly crdtPolicies: readonly RallarCrdtDocumentTypePolicy[] | undefined;
  readonly resilience: CreateApiV1MutationRuntimeInput['resilience'];
  readonly backgroundTasks: ApiV1BackgroundTaskLifecycle;
}

interface StartRuntimeStateExpiryInput {
  readonly database: PSqlSql;
  readonly nowEpochMs: () => number;
  readonly runtimeStateRepository: ApiV1MutationRuntime['runtimeStateRepository'];
  readonly startupGeneration: RuntimeStateExpiryStartupGeneration;
}

interface CreateSharedMiddlewareInput {
  readonly mutation: ApiV1MutationRuntime;
  readonly rtcTopology: ApiRtcTopologyRuntime;
  readonly wsRuntimeName: string;
  readonly queuePubSubChannel: string;
  readonly queuePubSubPublisherId: string;
  readonly databasePubSub: ApiV1DatabasePubSubConfig;
  readonly timing: RallarTimingSink;
}

interface CreateScalarRecomputeWorkerInput {
  readonly mutation: ApiV1MutationRuntime;
  readonly runtime: RallarMiddlewareRuntime;
  readonly database: PSqlSql;
  readonly serviceId: string;
  readonly nowEpochMs: () => number;
}

interface ApiV1ScalarRecomputeWorker {
  stop(): void;
  readonly firstRun: Promise<number>;
}

export interface ApiV1RuntimeConstructionOperations {
  createMutationRuntime(input: CreateApiV1MutationRuntimeInput): ApiV1MutationRuntime;
  createRtcTopologyRuntime(input: CreateApiRtcTopologyRuntimeInput): ApiRtcTopologyRuntime;
  configureWsRuntimeStores(name: string, database: PSqlSql): void;
  startResourceInboxExpiry(
    repository: ApiV1MutationRuntime['resourceInboxRepository'],
  ): void;
  startRuntimeStateExpiry(input: StartRuntimeStateExpiryInput): void;
  createMiddleware(input: CreateSharedMiddlewareInput): RallarMiddlewareRuntime;
  createScalarRecomputeWorker(input: CreateScalarRecomputeWorkerInput): ApiV1ScalarRecomputeWorker;
  startPresenceReconciliation(
    runtime: Pick<
      RallarMiddlewareRuntime,
      'appClientInboxService' | 'appGroupInboxService'
    >,
  ): Promise<void>;
  createSnapshotSelectors(
    mutation: ApiV1MutationRuntime,
    timing: RallarTimingSink,
  ): ApiStateSnapshotReadSelectors;
  requireRuntime(input: Parameters<typeof requireApiV1Runtime>[0]): ApiV1Runtime;
}

export function createApiV1Runtime(input: CreateApiV1RuntimeInput): ApiV1Runtime {
  return constructApiV1Runtime(input, PRODUCTION_OPERATIONS);
}

export function constructApiV1Runtime(
  input: CreateApiV1RuntimeInput,
  operations: ApiV1RuntimeConstructionOperations,
): ApiV1Runtime {
  const startupGeneration = input.backgroundTasks.beginStartupGeneration();
  const mutation = operations.createMutationRuntime(toMutationRuntimeInput(input));
  const rtcTopology = operations.createRtcTopologyRuntime({
    database: input.database,
    runtimeStateRepository: mutation.runtimeStateRepository,
    groupsRepository: mutation.groupsRepository,
    webSocketServer: mutation.webSocketServer,
    publisherStreamId: input.publisherStreamId,
    nowEpochMs: input.nowEpochMs,
    onCompactionFailure: (error) => {
      console.error('RTC topology delivery compaction failed:', error);
    },
    replayMode: input.rtcTopologyReplayMode,
    readHydrationIdentity: readAuthorisedWsConnectionIdentity,
  });
  input.backgroundTasks.register(rtcTopology.stop);
  operations.configureWsRuntimeStores(input.wsRuntimeName, input.database);
  operations.startResourceInboxExpiry(mutation.resourceInboxRepository);
  operations.startRuntimeStateExpiry({
    database: input.database,
    nowEpochMs: input.nowEpochMs,
    runtimeStateRepository: mutation.runtimeStateRepository,
    startupGeneration,
  });
  const runtime = operations.createMiddleware({
    mutation,
    rtcTopology,
    wsRuntimeName: input.wsRuntimeName,
    queuePubSubChannel: input.queuePubSubChannel,
    queuePubSubPublisherId: input.queuePubSubPublisherId,
    databasePubSub: input.databasePubSub,
    timing: input.timing,
  });
  rtcTopology.topologyReplay.attach({
    wsQueueBoxServerService: runtime.wsQBoxServerService,
  });
  const scalarRecomputeWorker = operations.createScalarRecomputeWorker({
    mutation,
    runtime,
    database: input.database,
    serviceId: input.serviceId,
    nowEpochMs: input.nowEpochMs,
  });
  input.backgroundTasks.register(scalarRecomputeWorker.stop);
  void scalarRecomputeWorker.firstRun.catch(() => undefined);
  void operations.startPresenceReconciliation(runtime)
    .catch((error) => console.error('Failed to initialise presence expiry reconciliation:', error));
  const selectors = operations.createSnapshotSelectors(mutation, input.timing);
  return operations.requireRuntime({
    runtime,
    authSessionRepository: mutation.authSessionRepository,
    ...selectors,
    groupFormationMetrics: mutation.groupFormationMetrics,
    backgroundTasks: input.backgroundTasks,
  });
}

function toMutationRuntimeInput(
  input: CreateApiV1RuntimeInput,
): CreateApiV1MutationRuntimeInput {
  return {
    database: input.database,
    serviceId: input.serviceId,
    authCredentialSecret: input.authCredentialSecret,
    nowEpochMs: input.nowEpochMs,
    timing: input.timing,
    appInboxOptions: input.appInboxOptions,
    clientFormationDamping: input.clientFormationDamping,
    groupCapacity: input.groupCapacity,
    groupStateDissemination: input.groupStateDissemination,
    createGroupFormationTopologyIntent: input.createGroupFormationTopologyIntent,
    adminClientIds: input.adminClientIds,
    crdtPolicies: input.crdtPolicies,
    resilience: input.resilience,
  };
}

const PRODUCTION_OPERATIONS: ApiV1RuntimeConstructionOperations = {
  createMutationRuntime: (input) => {
    const mutation = createApiV1MutationRuntime(input);
    setRtcTopologyOutboxWriteSink(mutation.groupFormationMetrics.topologyOutboxWritten);
    return mutation;
  },
  createRtcTopologyRuntime: createApiRtcTopologyRuntime,
  configureWsRuntimeStores: (name, database) => {
    configureServerWsQBoxALRuntimeStores(name, { sql: database });
  },
  startResourceInboxExpiry,
  startRuntimeStateExpiry: startRuntimeStateExpiry,
  createMiddleware: createSharedMiddleware,
  createScalarRecomputeWorker: (input) =>
    initApiRtcTopologyScalarRecomputeWorker({
      runtimeStateRepository: input.mutation.runtimeStateRepository,
      groupsRepository: input.mutation.groupsRepository,
      database: input.database,
      serviceId: input.serviceId,
      now: input.nowEpochMs,
      wake: () => input.runtime.qboxEngine.wake(),
    }),
  startPresenceReconciliation: initPresenceExpiryReconciliation,
  createSnapshotSelectors: (mutation, timing) =>
    createApiStateSnapshotReadSelectors({
      clientDurable: mutation.clientsRepository,
      clientCache: mutation.clientSnapshotCache,
      groupDurable: mutation.groupsRepository,
      groupCache: mutation.groupSnapshotCache,
    }, timing),
  requireRuntime: requireApiV1Runtime,
};

function startResourceInboxExpiry(
  repository: ApiV1MutationRuntime['resourceInboxRepository'],
): void {
  void initResourceInboxExpiryEviction(repository)
    .catch((error) => console.error('Failed to initialise resource inbox expiry eviction:', error));
}

function createSharedMiddleware(
  input: CreateSharedMiddlewareInput,
): RallarMiddlewareRuntime {
  const { mutation, rtcTopology } = input;
  return createRallarMiddleware({
    inbox: mutation.queueBox,
    outbox: mutation.queueBox,
    appInboxDequeueOptions: mutation.appInboxDequeueOptions,
    webSocketServer: mutation.webSocketServer,
    wsRuntimeName: input.wsRuntimeName,
    findGroupSnapshotByRef: (ref) => mutation.groupSnapshotCache.findByRef(ref),
    findClientSnapshotByRef: (ref) => findCurrentClientSnapshot(mutation.clientSnapshotCache, ref),
    inboundStores: resolveServerWsQBoxALInboundRuntimeStores(input.wsRuntimeName),
    outboundStores: resolveServerWsQBoxALOutboundRuntimeStores(input.wsRuntimeName),
    wsDeliveryDiagnostics: mutation.groupFormationMetrics.wsDelivery,
    createAppGroupInboxService: mutation.createAppGroupInboxService,
    createAppClientInboxService: mutation.createAppClientInboxService,
    createAppAuthInboxService: mutation.createAppAuthInboxService,
    createAppAdminInboxService: mutation.createAppAdminInboxService,
    createAppCrdtInboxService: mutation.createAppCrdtInboxService,
    resilience: mutation.resilience,
    clientsRepository: mutation.clientsRepository,
    groupsRepository: mutation.groupsRepository,
    rtcTopologyPublicationRepository: rtcTopology.publicationRepository,
    rtcTopologyExecutionRepository: rtcTopology.executionRepository,
    rtcTopologyDelivery: rtcTopology.topologyDelivery,
    rtcTopologyReplay: rtcTopology.topologyReplay,
    queuePubSubBridge: createApiRtcTopologyQueuePubSubBridge({
      config: input.databasePubSub,
      channel: input.queuePubSubChannel,
      publisherId: input.queuePubSubPublisherId,
      timing: input.timing,
      wakeReplay: () => rtcTopology.topologyReplay.wake('notification'),
    }),
    readiness: rtcTopology.readiness,
    healthFailure: rtcTopology.healthFailure,
  });
}

function startRuntimeStateExpiry(input: StartRuntimeStateExpiryInput): void {
  const rtcRttRepository = new RtcRttRepository(input.runtimeStateRepository, {
    now: input.nowEpochMs,
  });
  void runRuntimeStateExpiryStartupBarrier({
    backfillTopologyGenerations: () =>
      generationBackfill.backfillAllGroupTopologyConfigGenerations(
        new GroupTopologyConfigRepository(input.runtimeStateRepository),
      ),
    initialiseRtcRttReceiptFamilyCleanup: async () => {
      await input.startupGeneration.startRtcRttReceiptFamilyCleanup(() =>
        initRtcRttReceiptFamilyCleanup(rtcRttRepository, {
          onError: logRtcRttReceiptCleanupFailure,
        })
      );
    },
    isCurrentGeneration: input.startupGeneration.isCurrent,
    onDetachedRuntimeStateExpiryEvictionFailure: (error) => {
      console.error('Protected generic runtime-state expiry eviction failed:', error);
    },
    initialiseRuntimeStateExpiryEviction: () =>
      input.startupGeneration.startRuntimeStateExpiryEviction(() =>
        initRuntimeStateExpiryEviction(
          new PSqlRuntimeStateRepository(input.database),
          { excludedNamespaces: RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES },
        )
      ),
    onGenerationsBackfilled: (advanced) => {
      if (advanced > 0) {
        console.log(`Backfilled group topology config generations: ${advanced}`);
      }
    },
  }).catch((error) =>
    console.error(
      'Failed to backfill topology generations or initialise runtime state expiry eviction:',
      error,
    )
  );
}

function logRtcRttReceiptCleanupFailure(error: Error): void {
  console.error('RTC RTT receipt family cleanup failed:', error);
}
