import {
    configureServerWsQBoxALRuntimeStores,
    resolveServerWsQBoxALInboundRuntimeStores,
    resolveServerWsQBoxALOutboundRuntimeStores,
    toServerWsQBoxALRuntimeStoreId
} from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { PSqlQueueReleaseTiming } from '@shared-server/queuebox/postgres/p-sql-queue-release-timing.ts';
import { initResourceInboxExpiryEviction } from '@shared-server/queuebox/postgres/resource-inbox-maintenance.ts';
import {
    normalizeAppInboxOptions,
    validateAppInboxAttemptDeadlineMargin,
    type AppInboxOptions
} from '@shared-server/rallar-system/app-inbox/app-inbox-options.ts';
import type { GroupPolicyCapacityConfig } from '@shared-server/rallar-system/group-state/policy/group-membership-admission-policy.ts';
import { initPresenceExpiryReconciliation } from '@shared-server/rallar-system/group-state/presence/reconcile-expired-group-presence.ts';
import {
    startGroupRetentionReconciliation,
    type StartGroupRetentionReconciliationInput
} from '@shared-server/rallar-system/group-state/retention/reconcile-group-retention.ts';
import { createRallarMiddleware } from '@shared-server/rallar-system/middleware/create-rallar-middleware.ts';
import type { CreateRallarMiddlewareOptions } from '@shared-server/rallar-system/middleware/rallar-middleware-construction.ts';
import type { RallarMiddlewareRuntime } from '@shared-server/rallar-system/middleware/rallar-middleware-runtime.ts';
import { createRallarALOutboundCapturedPolicyTiming } from '@shared-server/rallar-system/observability/al-outbound-captured-policy-timing.ts';
import { createRallarALOutboundDequeueTiming } from '@shared-server/rallar-system/observability/al-outbound-dequeue-timing.ts';
import {
    createRallarAlmReceiptDiagnosticsRecorder,
    RALLAR_ALM_RECEIPT_DIAGNOSTICS_CAPACITY,
    type RallarAlmReceiptDiagnosticsRecorder
} from '@shared-server/rallar-system/observability/alm-receipt-diagnostics.ts';
import { createRallarPSqlReleaseTiming } from '@shared-server/rallar-system/observability/p-sql-release-timing.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import type { AppInboxCompletionNoticeChannel } from '@shared-server/rallar-system/queue-pubsub/app-inbox-completion-notice.ts';
import { RtcRttInboxService } from '@shared-server/rallar-system/rtc-rtt/inbox/rtc-rtt-inbox-service.ts';
import {
    initRtcRttReceiptFamilyCleanup
} from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-receipt-cleanup.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts';
import {
    RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES
} from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-runtime-namespaces.ts';
import { TopologyInboxService } from '@shared-server/rallar-system/topology/inbox/topology-inbox-service.ts';
import { WsOutboxProvenanceReader } from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { RuntimeStateExpiryWorker } from '@shared-server/runtime-state/postgres/runtime-state-expiry-worker.ts';
import { createVolatileALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type {
    ALInboundRuntimeStores,
    ALVolatileInboundRuntimeStores
} from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALOutboundCapturedPolicyTiming } from '@shared/alm/outbound/admission/al-outbound-captured-policy-timing.ts';
import type { RallarCrdtDocumentTypePolicy } from '@shared/crdt/mod.ts';
import { createDefaultBackgroundTimers } from '@shared/resilience/timers.ts';
import type { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import type { WsQueueBoxServerReceiptObserver } from '@shared/services/ws-queue-box-server/ws-queue-box-server-receipt-observation.ts';

import type {
    ApiV1DatabaseConfiguration,
    ApiV1TopologyDeliveryConfiguration,
    ApiV1TopologyReplayConfiguration
} from '../configuration/api-v1-configuration.ts';
import { findCurrentClientSnapshot } from '../crdt/create-api-crdt-document-authorizer.ts';
import type { ApiV1DatabaseNotificationPort } from '../db/api-v1-database-lifecycle.ts';
import {
    API_V1_LIVE_WS_NOTICE_CHANNEL,
    createApiV1LiveWsNoticeTransport
} from '../db/api-v1-live-ws-notice-transport.ts';
import { createApiV1AppInboxCompletionNotices } from '../db/create-postgres-app-inbox-completion-notice-transport.ts';
import { createApiV1RelayedAckNotices } from '../db/create-postgres-relayed-ack-notice-transport.ts';
import type { LocalQueuePubSubBus } from '../db/local-queue-pubsub-bridge.ts';
import {
    readAuthorisedWsConnectionEligibility,
    readAuthorisedWsConnectionIdentity
} from '../runtime/rtc-topology/authorised-ws-connection-registry.ts';
import {
    createApiRtcTopologyQueuePubSubBridge
} from '../runtime/rtc-topology/create-api-rtc-topology-queue-pub-sub-bridge.ts';
import {
    createApiRtcTopologyRuntime,
    type ApiRtcTopologyRuntime,
    type CreateApiRtcTopologyRuntimeInput
} from '../runtime/rtc-topology/create-api-rtc-topology-runtime.ts';
import {
    createApiStateSnapshotReadSelectors,
    type ApiStateSnapshotReadSelectors
} from '../services/create-api-state-snapshot-read-selectors.ts';
import {
    filterEligibleDurableWsSessionIds,
    filterEligibleLiveWsSessionIds
} from '../services/filter-eligible-live-ws-session-ids.ts';
import {
    runRuntimeStateExpiryStartupBarrier,
    type RuntimeStateExpiryStartupGeneration
} from '../services/runtime-state-expiry-startup.ts';
import type { ApiV1BackgroundTaskLifecycle } from './api-v1-background-task-lifecycle.ts';
import { requireApiV1Runtime, type ApiV1Runtime } from './api-v1-runtime.ts';
import {
    createApiV1MutationRuntime,
    type ApiV1MutationRuntime,
    type CreateApiV1MutationRuntimeInput
} from './create-api-v1-mutation-runtime.ts';
import {
    createApiV1RelicServices,
    type ApiV1RelicServices,
    type CreateApiV1RelicServicesInput
} from './create-api-v1-relic-services.ts';
import {
    createApiV1TopologyServices,
    type ApiV1TopologyServices,
    type CreateApiV1TopologyServicesInput
} from './create-api-v1-topology-services.ts';

export interface CreateApiV1RuntimeInput {
    readonly database: PSqlSql;
    readonly serviceId: string;
    readonly publisherStreamId: string;
    readonly queuePubSubPublisherId: string;
    readonly queuePubSubChannel: string;
    readonly queuePubSubLocalBus: LocalQueuePubSubBus;
    readonly wsRuntimeName: string;
    readonly authCredentialSecret: string;
    readonly maxConcurrentPasswordDerivations: number;
    readonly nowEpochMs: () => number;
    readonly timing: RallarTimingSink;
    readonly outboxStageTiming?: RallarTimingSink;
    /** Present only while timing is on: one line per strict principal group list. */
    readonly principalGroupListTiming?: RallarTimingSink;
    readonly wsReceiptObserver?: WsQueueBoxServerReceiptObserver;
    readonly appInboxOptions: AppInboxOptions;
    readonly appInboxNewLaneConcurrency: number;
    readonly appInboxNewLaneHeldRows: number;
    readonly appInboxFinishedRetentionMs: number;
    readonly disconnectedSessionRetentionMs: number;
    readonly groupCapacity: GroupPolicyCapacityConfig;
    readonly groupFormationRecomputeDebounceMs: number;
    readonly groupFormationRecomputeMaxWaitMs: number;
    readonly databasePubSubMode: ApiV1DatabaseConfiguration['pubSub'];
    readonly databaseNotification: ApiV1DatabaseNotificationPort | null;
    readonly topologyReplay: ApiV1TopologyReplayConfiguration;
    readonly topologyDelivery: ApiV1TopologyDeliveryConfiguration;
    readonly adminClientIds: readonly string[];
    readonly rtcTopologyOptions: CreateApiV1TopologyServicesInput['rtcTopologyOptions'];
    readonly rttRefinementGateConfig: CreateApiV1TopologyServicesInput['rttRefinementGateConfig'];
    readonly crdtPolicies: readonly RallarCrdtDocumentTypePolicy[];
    readonly resilience: CreateApiV1MutationRuntimeInput['resilience'];
    readonly backgroundTasks: ApiV1BackgroundTaskLifecycle;
}

interface StartRuntimeStateExpiryInput {
    readonly database: PSqlSql;
    readonly nowEpochMs: () => number;
    readonly runtimeStateRepository: ApiV1MutationRuntime['runtimeStateRepository'];
    readonly startupGeneration: RuntimeStateExpiryStartupGeneration;
}

interface StartMutationInfrastructureInput {
    readonly runtime: CreateApiV1RuntimeInput;
    readonly mutation: ApiV1MutationRuntime;
    readonly operations: ApiV1RuntimeConstructionOperations;
    readonly startupGeneration: RuntimeStateExpiryStartupGeneration;
}

interface CreateSharedMiddlewareInput {
    readonly mutation: ApiV1MutationRuntime;
    readonly appInboxCompletionNotices: AppInboxCompletionNoticeChannel | undefined;
    readonly rtcTopology: ApiRtcTopologyRuntime;
    readonly topology: ApiV1TopologyServices;
    readonly wsRuntimeName: string;
    readonly queuePubSubChannel: string;
    readonly queuePubSubPublisherId: string;
    readonly queuePubSubLocalBus: LocalQueuePubSubBus;
    readonly databasePubSubMode: ApiV1DatabaseConfiguration['pubSub'];
    readonly databaseNotification: ApiV1DatabaseNotificationPort | null;
    readonly timing: RallarTimingSink;
    readonly outboxStageTiming?: RallarTimingSink;
    readonly wsReceiptObserver?: WsQueueBoxServerReceiptObserver;
    readonly almReceiptDiagnostics: RallarAlmReceiptDiagnosticsRecorder;
    readonly inboundStores: ALInboundRuntimeStores;
    readonly nowEpochMs: () => number;
}

interface ApiV1RuntimeTopology {
    readonly rtcTopology: ApiRtcTopologyRuntime;
    readonly topology: ApiV1TopologyServices;
}

export interface ApiV1RuntimeConstructionOperations {
    createRelicServices(input: CreateApiV1RelicServicesInput): ApiV1RelicServices;
    createMutationRuntime(input: CreateApiV1MutationRuntimeInput): ApiV1MutationRuntime;
    createRtcTopologyRuntime(input: CreateApiRtcTopologyRuntimeInput): ApiRtcTopologyRuntime;
    createTopologyServices(input: CreateApiV1TopologyServicesInput): ApiV1TopologyServices;
    configureWsRuntimeStores(input: ConfigureWsRuntimeStoresInput): void;
    resolveWsInboundStores(wsRuntimeName: string): ALInboundRuntimeStores;
    startResourceInboxExpiry(
        mutation: Pick<ApiV1MutationRuntime, 'resourceInboxRepository' | 'resourceInboxResultsRepository'>
    ): void;
    startRuntimeStateExpiry(input: StartRuntimeStateExpiryInput): void;
    createMiddleware(input: CreateSharedMiddlewareInput): RallarMiddlewareRuntime;
    startPresenceReconciliation(
        runtime: Pick<RallarMiddlewareRuntime, 'appClientInboxService' | 'groupStateInboxService'>
    ): Promise<void>;
    startRetentionReconciliation(input: StartGroupRetentionReconciliationInput): () => Promise<void>;
    createSnapshotSelectors(
        mutation: ApiV1MutationRuntime,
        timing: RallarTimingSink
    ): ApiStateSnapshotReadSelectors;
    requireRuntime(input: Parameters<typeof requireApiV1Runtime>[0]): ApiV1Runtime;
}

interface ConfigureWsRuntimeStoresInput {
    readonly name: string;
    readonly repository: ApiV1MutationRuntime['runtimeStateRepository'];
    readonly outboundReleaseTiming: PSqlQueueReleaseTiming.Port | undefined;
    readonly capturedPolicyTiming: ALOutboundCapturedPolicyTiming.Capability | undefined;
}

export function createApiV1Runtime(input: CreateApiV1RuntimeInput): ApiV1Runtime {
    return constructApiV1Runtime(input, PRODUCTION_OPERATIONS);
}

export function constructApiV1Runtime(
    input: CreateApiV1RuntimeInput,
    operations: ApiV1RuntimeConstructionOperations
): ApiV1Runtime {
    requireRuntimeAppInboxDeadline(input);
    const startupGeneration = input.backgroundTasks.beginStartupGeneration();
    const almReceiptDiagnostics = createRallarAlmReceiptDiagnosticsRecorder({
        nowEpochMs: input.nowEpochMs,
        capacity: RALLAR_ALM_RECEIPT_DIAGNOSTICS_CAPACITY
    });
    const appInboxCompletionNotices = createApiV1AppInboxCompletionNotices({
        mode: input.databasePubSubMode,
        notification: input.databaseNotification,
        publisherId: input.queuePubSubPublisherId
    });
    const mutation = operations.createMutationRuntime(toMutationRuntimeInput(input, appInboxCompletionNotices));
    const { rtcTopology, topology } = createRuntimeTopology(input, mutation, operations);
    input.backgroundTasks.register(rtcTopology.stop);
    startMutationInfrastructure({ runtime: input, mutation, operations, startupGeneration });
    const inboundStores = operations.resolveWsInboundStores(input.wsRuntimeName);
    const runtime = operations.createMiddleware({
        mutation,
        appInboxCompletionNotices,
        rtcTopology,
        topology,
        wsRuntimeName: input.wsRuntimeName,
        queuePubSubChannel: input.queuePubSubChannel,
        queuePubSubPublisherId: input.queuePubSubPublisherId,
        queuePubSubLocalBus: input.queuePubSubLocalBus,
        databasePubSubMode: input.databasePubSubMode,
        databaseNotification: input.databaseNotification,
        timing: input.timing,
        outboxStageTiming: input.outboxStageTiming,
        wsReceiptObserver: input.wsReceiptObserver,
        almReceiptDiagnostics,
        inboundStores,
        nowEpochMs: input.nowEpochMs
    });
    const relic = operations.createRelicServices({
        mutation,
        runtime,
        wsRuntimeName: input.wsRuntimeName,
        nowEpochMs: input.nowEpochMs,
        timing: input.timing
    });
    rtcTopology.topologyReplay.attach({ wsQueueBoxServerService: runtime.wsQBoxServerService });
    startGroupMaintenance({ runtime, mutation, input, operations });
    const selectors = operations.createSnapshotSelectors(mutation, input.timing);
    return operations.requireRuntime({
        runtime,
        ...relic,
        authSessionRepository: mutation.authSessionRepository,
        passwordDerivationAdmission: mutation.passwordDerivationAdmission,
        ...selectors,
        groupFormationMetrics: mutation.groupFormationMetrics,
        almReceiptDiagnostics,
        readAlmDeliveredMarkers: () => inboundStores.admissionStore.readDeliveredMarkerCount(input.nowEpochMs()),
        groupCurrentSnapshotCache: mutation.groupCurrentSnapshotCache,
        topologyServices: topology,
        backgroundTasks: input.backgroundTasks
    });
}

function requireRuntimeAppInboxDeadline(input: CreateApiV1RuntimeInput): void {
    const deadlineIssues = validateAppInboxAttemptDeadlineMargin(
        input.appInboxOptions,
        input.resilience.inbox.reservationLeaseMs
    );
    if (deadlineIssues.length > 0) {
        throw new Error(deadlineIssues.map((issue) => issue.message).join('; '));
    }
}

interface StartGroupMaintenanceInput {
    readonly runtime: RallarMiddlewareRuntime;
    readonly mutation: ApiV1MutationRuntime;
    readonly input: CreateApiV1RuntimeInput;
    readonly operations: ApiV1RuntimeConstructionOperations;
}

/** Queue capabilities exist before maintenance starts; the runtime owns stopping and draining retention scans. */
function startGroupMaintenance({ runtime, mutation, input, operations }: StartGroupMaintenanceInput): void {
    void operations.startPresenceReconciliation(runtime)
        .catch((error) => console.error('Failed to initialise presence expiry reconciliation:', error));
    input.backgroundTasks.register(operations.startRetentionReconciliation({
        repository: mutation.groupsRepository,
        enqueue: async (command) => {
            await runtime.groupStateInboxService.enqueueGroupRetention(command);
        },
        timers: createDefaultBackgroundTimers(),
        now: input.nowEpochMs,
        newObservationId: () => crypto.randomUUID(),
        onFailure: (error) => console.error('Group retention reconciliation failed:', error),
        intervalMs: 60_000,
        pageSize: 100
    }));
}

/** The mutation runtime's stores and expiry workers start before middleware owns its queue. */
function startMutationInfrastructure(input: StartMutationInfrastructureInput): void {
    const { runtime, mutation, operations, startupGeneration } = input;
    const outboundReleaseTiming = runtime.outboxStageTiming === undefined ? undefined : createRallarPSqlReleaseTiming({
        timing: runtime.outboxStageTiming,
        serviceId: runtime.serviceId,
        publisherId: runtime.queuePubSubPublisherId,
        processId: Deno.pid,
        processStartedAtEpochMs: performance.timeOrigin,
        transactionScope: 'root',
        readMonotonicMs: () => performance.now(),
        readEpochMs: runtime.nowEpochMs
    });
    const capturedPolicyTiming = runtime.outboxStageTiming === undefined
        ? undefined
        : createRallarALOutboundCapturedPolicyTiming({
            timing: runtime.outboxStageTiming,
            serviceId: runtime.serviceId,
            publisherId: runtime.queuePubSubPublisherId,
            processId: Deno.pid,
            processStartedAtEpochMs: performance.timeOrigin,
            readMonotonicMs: () => performance.now(),
            readEpochMs: runtime.nowEpochMs
        });
    operations.configureWsRuntimeStores({
        name: runtime.wsRuntimeName,
        repository: mutation.runtimeStateRepository,
        outboundReleaseTiming,
        capturedPolicyTiming
    });
    operations.startResourceInboxExpiry(mutation);
    operations.startRuntimeStateExpiry({
        database: runtime.database,
        nowEpochMs: runtime.nowEpochMs,
        runtimeStateRepository: mutation.runtimeStateRepository,
        startupGeneration
    });
}

function createRuntimeTopology(
    input: CreateApiV1RuntimeInput,
    mutation: ApiV1MutationRuntime,
    operations: ApiV1RuntimeConstructionOperations
): ApiV1RuntimeTopology {
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
        replay: input.topologyReplay,
        delivery: input.topologyDelivery,
        readHydrationIdentity: readAuthorisedWsConnectionIdentity
    });
    const topology = operations.createTopologyServices({
        pendingReplanReader: mutation.resourceInboxRepository.entries,
        runtimeStateRepository: mutation.runtimeStateRepository,
        groupStateRepository: mutation.groupsRepository,
        groupStateService: mutation.groupStateService,
        groupFormationRttMutation: mutation.groupFormationMetrics.rttMutation,
        topologyOutboxWritten: mutation.groupFormationMetrics.topologyOutboxWritten,
        topologyReplayMetrics: rtcTopology.topologyReplay,
        adminClientIds: input.adminClientIds,
        rtcTopologyOptions: input.rtcTopologyOptions,
        rttRefinementGateConfig: input.rttRefinementGateConfig,
        nowEpochMs: input.nowEpochMs,
        finishedRetentionMs: input.appInboxFinishedRetentionMs
    });
    return { rtcTopology, topology };
}

function toMutationRuntimeInput(
    input: CreateApiV1RuntimeInput,
    appInboxCompletionNotices: AppInboxCompletionNoticeChannel | undefined
): CreateApiV1MutationRuntimeInput {
    return {
        appInboxCompletionNotices,
        database: input.database,
        serviceId: input.serviceId,
        authCredentialSecret: input.authCredentialSecret,
        maxConcurrentPasswordDerivations: input.maxConcurrentPasswordDerivations,
        nowEpochMs: input.nowEpochMs,
        timing: input.timing,
        outboxStageTiming: input.outboxStageTiming,
        principalGroupListTiming: input.principalGroupListTiming,
        appInboxOptions: input.appInboxOptions,
        appInboxNewLaneConcurrency: input.appInboxNewLaneConcurrency,
        appInboxNewLaneHeldRows: input.appInboxNewLaneHeldRows,
        appInboxFinishedRetentionMs: input.appInboxFinishedRetentionMs,
        disconnectedSessionRetentionMs: input.disconnectedSessionRetentionMs,
        groupCapacity: input.groupCapacity,
        groupFormationRecomputeDebounceMs: input.groupFormationRecomputeDebounceMs,
        groupFormationRecomputeMaxWaitMs: input.groupFormationRecomputeMaxWaitMs,
        adminClientIds: input.adminClientIds,
        crdtPolicies: input.crdtPolicies,
        resilience: input.resilience
    };
}

const PRODUCTION_OPERATIONS: ApiV1RuntimeConstructionOperations = {
    createRelicServices: createApiV1RelicServices,
    createMutationRuntime: createApiV1MutationRuntime,
    createRtcTopologyRuntime: createApiRtcTopologyRuntime,
    createTopologyServices: createApiV1TopologyServices,
    configureWsRuntimeStores: (input) => {
        configureServerWsQBoxALRuntimeStores(input.name, {
            repository: input.repository,
            outboundReleaseTiming: input.outboundReleaseTiming,
            capturedPolicyTiming: input.capturedPolicyTiming
        });
    },
    resolveWsInboundStores: resolveServerWsQBoxALInboundRuntimeStores,
    startResourceInboxExpiry,
    startRuntimeStateExpiry,
    createMiddleware: createSharedMiddleware,
    startPresenceReconciliation: initPresenceExpiryReconciliation,
    startRetentionReconciliation: startGroupRetentionReconciliation,
    createSnapshotSelectors: (mutation, timing) =>
        createApiStateSnapshotReadSelectors({
            clientDurable: mutation.clientsRepository,
            clientCache: mutation.clientSnapshotCache,
            groupDurable: mutation.groupCurrentSnapshotCache,
            groupCache: mutation.groupSnapshotCache
        }, timing),
    requireRuntime: requireApiV1Runtime
};

function startResourceInboxExpiry(
    mutation: Pick<ApiV1MutationRuntime, 'resourceInboxRepository' | 'resourceInboxResultsRepository'>
): void {
    void initResourceInboxExpiryEviction({
        entries: mutation.resourceInboxRepository.maintenance,
        results: mutation.resourceInboxResultsRepository
    })
        .catch((error) => console.error('Failed to initialise resource inbox expiry eviction:', error));
}

function createSharedMiddleware(
    input: CreateSharedMiddlewareInput
): RallarMiddlewareRuntime {
    const { mutation, rtcTopology } = input;
    const { inboundStores } = input;
    const relayedAckNotices = createApiV1RelayedAckNotices({
        mode: input.databasePubSubMode,
        notification: input.databaseNotification,
        publisherId: input.queuePubSubPublisherId
    });
    const wsOutboxProvenance = new WsOutboxProvenanceReader({
        repository: mutation.runtimeStateRepository,
        nowMs: input.nowEpochMs
    });
    return createRallarMiddleware({
        inbox: mutation.queueBox,
        outbox: mutation.queueBox,
        appInboxDequeueOptions: mutation.appInboxDequeueOptions,
        ...createMiddlewareTimingOptions(input),
        webSocketServer: mutation.webSocketServer,
        readAuthenticatedConnectionScope: readAuthorisedWsConnectionEligibility,
        readWsOutboxProducerProvenance: (message, entry) => wsOutboxProvenance.readProducerProvenance(message, entry),
        wsRuntimeName: input.wsRuntimeName,
        findGroupSnapshotByRef: (ref) => mutation.groupSnapshotCache.findByRef(ref),
        findClientSnapshotByRef: (ref) => findCurrentClientSnapshot(mutation.clientSnapshotCache, ref),
        inboundStores,
        inboundVolatileStores: createServerWsQBoxALVolatileInboundRuntimeStores(input.wsRuntimeName),
        outboundStores: resolveServerWsQBoxALOutboundRuntimeStores(input.wsRuntimeName),
        wsDeliveryDiagnostics: mutation.groupFormationMetrics.wsDelivery,
        wsOutboundDiagnostics: mutation.groupFormationMetrics.outboundWork,
        wsOutboundSettlements: input.almReceiptDiagnostics.settlements,
        wsReceiptObserver: input.wsReceiptObserver,
        createGroupStateInboxService: mutation.createGroupStateInboxService,
        createTopologyInboxService: ({ inboxQueueReader, wakeQueueEngine }) =>
            createTopologyInboxService(input, inboxQueueReader, wakeQueueEngine),
        createRtcRttInboxService: ({ inboxQueueReader, wakeQueueEngine }) =>
            createRtcRttInboxService(input, inboxQueueReader, wakeQueueEngine),
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
        queuePubSubBridge: createApiV1QueuePubSubBridge(input),
        liveWsNoticeSubscriber: createApiV1LiveWsNoticeSubscriber(input),
        relayedAckNotices,
        appInboxCompletionNotices: input.appInboxCompletionNotices,
        readiness: rtcTopology.readiness,
        healthFailure: rtcTopology.healthFailure
    });
}

/** Composes the independently gated inbox and outbound dequeue process timings. */
function createMiddlewareTimingOptions(
    input: CreateSharedMiddlewareInput
): Pick<CreateRallarMiddlewareOptions, 'appInboxDequeuePassTiming' | 'wsDequeueTiming'> {
    return {
        appInboxDequeuePassTiming: normalizeAppInboxOptions(input.mutation.appInboxOptions).phaseTiming
            ? { database: input.mutation.database, serviceId: input.mutation.serviceId, sink: input.timing }
            : undefined,
        wsDequeueTiming: input.outboxStageTiming === undefined ? undefined : createRallarALOutboundDequeueTiming({
            timing: input.outboxStageTiming,
            serviceId: input.mutation.serviceId,
            publisherId: input.queuePubSubPublisherId
        })
    };
}

/** No volatile budget: the server sends nothing of its own on this lane, and an arrival is never refused. */
function createServerWsQBoxALVolatileInboundRuntimeStores(wsRuntimeName: string): ALVolatileInboundRuntimeStores {
    return createVolatileALInboundRuntimeStores(
        { namespace: `${toServerWsQBoxALRuntimeStoreId(wsRuntimeName)}:volatile` },
        undefined
    );
}

function createApiV1QueuePubSubBridge(
    input: CreateSharedMiddlewareInput
): CreateRallarMiddlewareOptions['queuePubSubBridge'] {
    return createApiRtcTopologyQueuePubSubBridge({
        mode: input.databasePubSubMode,
        notification: input.databaseNotification,
        localBus: input.queuePubSubLocalBus,
        channel: input.queuePubSubChannel,
        publisherId: input.queuePubSubPublisherId,
        timing: input.outboxStageTiming,
        wakeReplay: () => input.rtcTopology.topologyReplay.wake('notification'),
        filterEligibleCapturedSessionIds: (captured) =>
            filterEligibleDurableWsSessionIds({
                ...captured,
                socketServer: input.mutation.webSocketServer,
                nowMs: input.nowEpochMs()
            })
    });
}

function createTopologyInboxService(
    input: CreateSharedMiddlewareInput,
    inboxQueueReader: InboxQueueReader,
    wakeQueueEngine: () => void
): TopologyInboxService {
    const { mutation, topology } = input;
    return new TopologyInboxService({
        inboxQueueReader,
        resourceInboxRepository: mutation.resourceInboxRepository.entries,
        resourceInboxResultsRepository: mutation.resourceInboxResultsRepository,
        database: mutation.database,
        groupStateService: mutation.groupStateService,
        mutationOwners: topology.topologyMutationOwners
    }, {
        serviceId: mutation.serviceId,
        finishedRetentionMs: mutation.appInboxFinishedRetentionMs,
        timing: input.timing,
        options: mutation.appInboxOptions,
        wakeOwningQueue: wakeQueueEngine
    });
}

function createRtcRttInboxService(
    input: CreateSharedMiddlewareInput,
    inboxQueueReader: InboxQueueReader,
    wakeQueueEngine: () => void
): RtcRttInboxService {
    const { mutation, topology } = input;
    return new RtcRttInboxService({
        inboxQueueReader,
        resourceInboxRepository: mutation.resourceInboxRepository.entries,
        resourceInboxResultsRepository: mutation.resourceInboxResultsRepository,
        database: mutation.database,
        groupStateService: mutation.groupStateService,
        mutationDependencies: topology.rtcRttMutationDependencies
    }, {
        serviceId: mutation.serviceId,
        finishedRetentionMs: mutation.appInboxFinishedRetentionMs,
        timing: input.timing,
        options: mutation.appInboxOptions,
        wakeOwningQueue: wakeQueueEngine
    });
}

function createApiV1LiveWsNoticeSubscriber(
    input: CreateSharedMiddlewareInput
): CreateRallarMiddlewareOptions['liveWsNoticeSubscriber'] {
    if (input.databasePubSubMode === 'disabled') {
        return undefined;
    }
    return {
        transport: createApiV1LiveWsNoticeTransport({
            mode: input.databasePubSubMode,
            publisherId: input.queuePubSubPublisherId,
            notification: input.databaseNotification,
            localBus: input.queuePubSubLocalBus,
            nowMs: input.nowEpochMs
        }),
        channel: API_V1_LIVE_WS_NOTICE_CHANNEL,
        publisherId: input.queuePubSubPublisherId,
        nowMs: input.nowEpochMs,
        filterEligibleRecipientSessionIds: (candidateSessionIds, notice) =>
            filterEligibleLiveWsSessionIds({
                socketServer: input.mutation.webSocketServer,
                candidateSessionIds,
                notice,
                nowMs: input.nowEpochMs()
            })
    };
}

function startRuntimeStateExpiry(input: StartRuntimeStateExpiryInput): void {
    const rtcRttRepository = new RtcRttRepository(input.runtimeStateRepository, {
        now: input.nowEpochMs
    });
    void runRuntimeStateExpiryStartupBarrier({
        initialiseRtcRttReceiptFamilyCleanup: async () => {
            await input.startupGeneration.startRtcRttReceiptFamilyCleanup(() =>
                initRtcRttReceiptFamilyCleanup(rtcRttRepository, {
                    onError: logRtcRttReceiptCleanupFailure
                })
            );
        },
        isCurrentGeneration: input.startupGeneration.isCurrent,
        onDetachedRuntimeStateExpiryEvictionFailure: (error) => {
            console.error('Protected generic runtime-state expiry eviction failed:', error);
        },
        initialiseRuntimeStateExpiryEviction: () =>
            input.startupGeneration.startRuntimeStateExpiryEviction(() =>
                new RuntimeStateExpiryWorker({
                    repository: new PSqlRuntimeStateRepository(input.database),
                    excludedNamespaces: RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES
                })
            )
    }).catch((error) =>
        console.error(
            'Failed to initialise runtime state expiry eviction:',
            error
        )
    );
}

function logRtcRttReceiptCleanupFailure(error: Error): void {
    console.error('RTC RTT receipt family cleanup failed:', error);
}
