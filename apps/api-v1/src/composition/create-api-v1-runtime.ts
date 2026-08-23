import {
    configureServerWsQBoxALRuntimeStores,
    resolveServerWsQBoxALInboundRuntimeStores,
    resolveServerWsQBoxALOutboundRuntimeStores
} from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { initResourceInboxExpiryEviction } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import type { AppInboxOptions } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-client.ts';
import { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import { initPresenceExpiryReconciliation } from '@shared-server/rallar-system/group-state/presence/reconcile-expired-group-presence.ts';
import {
    createRallarMiddleware,
    type RallarMiddlewareRuntime
} from '@shared-server/rallar-system/middleware/rallar-middleware.ts';
import { type RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import { RtcRttInboxService } from '@shared-server/rallar-system/rtc-rtt/inbox/rtc-rtt-inbox-service.ts';
import {
    initRtcRttReceiptFamilyCleanup
} from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-receipt-cleanup.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts';
import {
    RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES
} from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-runtime-namespaces.ts';
import { TopologyInboxService } from '@shared-server/rallar-system/topology/inbox/topology-inbox-service.ts';
import { setRtcTopologyOutboxWriteSink } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-entry.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { RuntimeStateExpiryWorker } from '@shared-server/runtime-state/postgres/runtime-state-expiry-worker.ts';
import type { RallarCrdtDocumentTypePolicy } from '@shared/crdt/mod.ts';

import type {
    GroupPolicyCapacityConfig
} from '@shared-server/rallar-system/group-state/policy/group-membership-admission-policy.ts';
import type {
    ApiV1DatabaseConfiguration,
    ApiV1TopologyDeliveryConfiguration,
    ApiV1TopologyReplayConfiguration
} from '../configuration/api-v1-configuration.ts';
import { findCurrentClientSnapshot } from '../crdt/create-api-crdt-document-authorizer.ts';
import type { ApiV1DatabaseNotificationPort } from '../db/api-v1-database-lifecycle.ts';
import { readAuthorisedWsConnectionIdentity } from '../runtime/rtc-topology/authorised-ws-connection-registry.ts';
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
    readonly wsRuntimeName: string;
    readonly authCredentialSecret: string;
    readonly nowEpochMs: () => number;
    readonly timing: RallarTimingSink;
    readonly appInboxOptions: AppInboxOptions;
    readonly groupCapacity: GroupPolicyCapacityConfig;
    readonly groupFormationRecomputeDebounceMs: number;
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

interface CreateSharedMiddlewareInput {
    readonly mutation: ApiV1MutationRuntime;
    readonly rtcTopology: ApiRtcTopologyRuntime;
    readonly topology: ApiV1TopologyServices;
    readonly wsRuntimeName: string;
    readonly queuePubSubChannel: string;
    readonly queuePubSubPublisherId: string;
    readonly databasePubSubMode: ApiV1DatabaseConfiguration['pubSub'];
    readonly databaseNotification: ApiV1DatabaseNotificationPort | null;
    readonly timing: RallarTimingSink;
}

export interface ApiV1RuntimeConstructionOperations {
    createMutationRuntime(input: CreateApiV1MutationRuntimeInput): ApiV1MutationRuntime;
    createRtcTopologyRuntime(input: CreateApiRtcTopologyRuntimeInput): ApiRtcTopologyRuntime;
    createTopologyServices(input: CreateApiV1TopologyServicesInput): ApiV1TopologyServices;
    configureWsRuntimeStores(
        name: string,
        repository: ApiV1MutationRuntime['runtimeStateRepository']
    ): void;
    startResourceInboxExpiry(
        repository: ApiV1MutationRuntime['resourceInboxRepository']
    ): void;
    startRuntimeStateExpiry(input: StartRuntimeStateExpiryInput): void;
    createMiddleware(input: CreateSharedMiddlewareInput): RallarMiddlewareRuntime;
    startPresenceReconciliation(
        runtime: Pick<RallarMiddlewareRuntime, 'appClientInboxService' | 'groupStateInboxService'>
    ): Promise<void>;
    createSnapshotSelectors(
        mutation: ApiV1MutationRuntime,
        timing: RallarTimingSink
    ): ApiStateSnapshotReadSelectors;
    requireRuntime(input: Parameters<typeof requireApiV1Runtime>[0]): ApiV1Runtime;
}

export function createApiV1Runtime(input: CreateApiV1RuntimeInput): ApiV1Runtime {
    return constructApiV1Runtime(input, PRODUCTION_OPERATIONS);
}

export function constructApiV1Runtime(
    input: CreateApiV1RuntimeInput,
    operations: ApiV1RuntimeConstructionOperations
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
        replay: input.topologyReplay,
        delivery: input.topologyDelivery,
        readHydrationIdentity: readAuthorisedWsConnectionIdentity
    });
    const topology = operations.createTopologyServices({
        runtimeStateRepository: mutation.runtimeStateRepository,
        groupStateService: mutation.groupStateService,
        groupFormationRttMutation: mutation.groupFormationMetrics.rttMutation,
        webSocketServer: mutation.webSocketServer,
        topologyReplayMetrics: rtcTopology.topologyReplay,
        serviceId: mutation.serviceId,
        adminClientIds: input.adminClientIds,
        rtcTopologyOptions: input.rtcTopologyOptions,
        rttRefinementGateConfig: input.rttRefinementGateConfig,
        nowEpochMs: input.nowEpochMs,
        timing: input.timing
    });
    input.backgroundTasks.register(rtcTopology.stop);
    operations.configureWsRuntimeStores(
        input.wsRuntimeName,
        mutation.runtimeStateRepository
    );
    operations.startResourceInboxExpiry(mutation.resourceInboxRepository);
    operations.startRuntimeStateExpiry({
        database: input.database,
        nowEpochMs: input.nowEpochMs,
        runtimeStateRepository: mutation.runtimeStateRepository,
        startupGeneration
    });
    const runtime = operations.createMiddleware({
        mutation,
        rtcTopology,
        topology,
        wsRuntimeName: input.wsRuntimeName,
        queuePubSubChannel: input.queuePubSubChannel,
        queuePubSubPublisherId: input.queuePubSubPublisherId,
        databasePubSubMode: input.databasePubSubMode,
        databaseNotification: input.databaseNotification,
        timing: input.timing
    });
    rtcTopology.topologyReplay.attach({
        wsQueueBoxServerService: runtime.wsQBoxServerService
    });
    void operations.startPresenceReconciliation(runtime)
        .catch((error) => console.error('Failed to initialise presence expiry reconciliation:', error));
    const selectors = operations.createSnapshotSelectors(mutation, input.timing);
    return operations.requireRuntime({
        runtime,
        authSessionRepository: mutation.authSessionRepository,
        ...selectors,
        groupFormationMetrics: mutation.groupFormationMetrics,
        topologyServices: topology,
        backgroundTasks: input.backgroundTasks
    });
}

function toMutationRuntimeInput(
    input: CreateApiV1RuntimeInput
): CreateApiV1MutationRuntimeInput {
    return {
        database: input.database,
        serviceId: input.serviceId,
        authCredentialSecret: input.authCredentialSecret,
        nowEpochMs: input.nowEpochMs,
        timing: input.timing,
        appInboxOptions: input.appInboxOptions,
        groupCapacity: input.groupCapacity,
        groupFormationRecomputeDebounceMs: input.groupFormationRecomputeDebounceMs,
        adminClientIds: input.adminClientIds,
        crdtPolicies: input.crdtPolicies,
        resilience: input.resilience
    };
}

const PRODUCTION_OPERATIONS: ApiV1RuntimeConstructionOperations = {
    createMutationRuntime: (input) => {
        const mutation = createApiV1MutationRuntime(input);
        setRtcTopologyOutboxWriteSink(mutation.groupFormationMetrics.topologyOutboxWritten);
        return mutation;
    },
    createRtcTopologyRuntime: createApiRtcTopologyRuntime,
    createTopologyServices: createApiV1TopologyServices,
    configureWsRuntimeStores: (name, repository) => {
        configureServerWsQBoxALRuntimeStores(name, { repository });
    },
    startResourceInboxExpiry,
    startRuntimeStateExpiry: startRuntimeStateExpiry,
    createMiddleware: createSharedMiddleware,
    startPresenceReconciliation: initPresenceExpiryReconciliation,
    createSnapshotSelectors: (mutation, timing) =>
        createApiStateSnapshotReadSelectors({
            clientDurable: mutation.clientsRepository,
            clientCache: mutation.clientSnapshotCache,
            groupDurable: mutation.groupsRepository,
            groupCache: mutation.groupSnapshotCache
        }, timing),
    requireRuntime: requireApiV1Runtime
};

function startResourceInboxExpiry(
    repository: ApiV1MutationRuntime['resourceInboxRepository']
): void {
    void initResourceInboxExpiryEviction(repository)
        .catch((error) => console.error('Failed to initialise resource inbox expiry eviction:', error));
}

function createSharedMiddleware(
    input: CreateSharedMiddlewareInput
): RallarMiddlewareRuntime {
    const { mutation, rtcTopology, topology } = input;
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
        createGroupStateInboxService: mutation.createGroupStateInboxService,
        createTopologyInboxService: ({ inboxQueueReader, wakeQueueEngine }) =>
            new TopologyInboxService(
                {
                    inboxQueueReader,
                    resourceInboxRepository: mutation.resourceInboxRepository,
                    resourceInboxResultsRepository: mutation.resourceInboxResultsRepository,
                    database: mutation.database,
                    groupStateService: mutation.groupStateService,
                    mutationOwners: topology.topologyMutationOwners
                },
                {
                    serviceId: mutation.serviceId,
                    timing: input.timing,
                    options: mutation.appInboxOptions,
                    wakeOwningQueue: wakeQueueEngine
                }
            ),
        createRtcRttInboxService: ({ inboxQueueReader, wakeQueueEngine }) =>
            new RtcRttInboxService(
                {
                    inboxQueueReader,
                    resourceInboxRepository: mutation.resourceInboxRepository,
                    resourceInboxResultsRepository: mutation.resourceInboxResultsRepository,
                    database: mutation.database,
                    groupStateService: mutation.groupStateService,
                    mutationDependencies: topology.rtcRttMutationDependencies
                },
                {
                    serviceId: mutation.serviceId,
                    timing: input.timing,
                    options: mutation.appInboxOptions,
                    wakeOwningQueue: wakeQueueEngine
                }
            ),
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
            mode: input.databasePubSubMode,
            notification: input.databaseNotification,
            channel: input.queuePubSubChannel,
            publisherId: input.queuePubSubPublisherId,
            timing: input.timing,
            wakeReplay: () => rtcTopology.topologyReplay.wake('notification')
        }),
        readiness: rtcTopology.readiness,
        healthFailure: rtcTopology.healthFailure
    });
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
