import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { RallarServerSystemInstallers } from '@shared-server/rallar-facade/RallarServer.ts';
import { installChatWsTopic } from '@shared-server/rallar-system/communication/install-chat-ws-topic.ts';
import { installRtcSignalingWsTopic } from '@shared-server/rallar-system/communication/install-rtc-signaling-ws-topic.ts';
import { createCrdtWsMutationIngress } from '@shared-server/rallar-system/crdt/inbox/create-crdt-ws-mutation-ingress.ts';
import { installRallarCrdtWsTopics } from '@shared-server/rallar-system/crdt/realtime/install-rallar-crdt-ws-topics.ts';
import {
    type RallarCrdtServerMutationIngress
} from '@shared-server/rallar-system/crdt/realtime/rallar-crdt-server-contracts.ts';
import {
    installRtcRttSystemTopic,
    type InstallRtcRttSystemTopicOptions
} from '@shared-server/rallar-system/rtc-rtt/topic/install-rtc-rtt-system-topic.ts';
import {
    installStateSyncWsTopics,
    type InstallStateSyncWsTopicsOptions
} from '@shared-server/rallar-system/state-sync/install-state-sync-ws-topics.ts';
import type { RtcTopologyWorkPublisher } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-work.ts';
import { installTopologyWsTopics } from '@shared-server/rallar-system/topology/publication/install-topology-ws-topics.ts';
import {
    installTopologyAppOutbox,
    type InstallTopologyAppOutboxOptions
} from '@shared-server/rallar-system/topology/runtime/install-topology-app-outbox.ts';
import type { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import {
    initWsLifecycle,
    scheduleWsLifecycleRetry
} from '@shared-server/rallar-system/websocket/ws-lifecycle-service.ts';
import type { RallarCrdtAdminReadRepository, RallarCrdtDocumentTypePolicy } from '@shared/crdt/mod.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';

import * as wsRoutes from '../routes/ws-routes.ts';
import type { ApiV1Runtime } from './api-v1-runtime.ts';
import type { ApiV1TopologyServices } from './create-api-v1-topology-services.ts';

export interface ApiV1SystemInstallerTopology {
    readonly rtcTopologyService: object;
    readonly rtcTopologyOptions: ApiV1TopologyServices['rtcTopologyOptions'];
    readonly topologyQuery: object;
    readonly topologyPlanning: object;
    readonly topologyConfigRepository: object;
    readonly groupStateRepository: Pick<ApiV1TopologyServices['groupStateRepository'], 'readLifecyclePolicy'>;
    readonly topologySnapshotRepository: object;
    readonly rttRepository: object;
    readonly rttRefinementGate: object;
    readonly rttRefinementService: object;
}

export interface CreateApiV1SystemInstallersInput<
    Topology extends ApiV1SystemInstallerTopology = ApiV1TopologyServices,
> {
    readonly database: PSqlSql;
    readonly serviceId: string;
    readonly nowEpochMs: () => number;
    readonly topology: Topology;
    readonly crdtLogRepository: RallarCrdtAdminReadRepository;
    readonly crdtPolicies: readonly RallarCrdtDocumentTypePolicy[];
    readonly globalGraphRecomputeLimit: InstallRtcRttSystemTopicOptions['globalGraphRecomputeLimit'];
}

export interface ApiV1SystemInstallerRuntime {
    readonly wsQBoxServerService: ApiV1Runtime['wsQBoxServerService'];
    readonly appClientInboxService: Pick<ApiV1Runtime['appClientInboxService'], 'enqueueAuthorisedWsClientDisconnect'>;
    readonly groupStateInboxService: Pick<
        ApiV1Runtime['groupStateInboxService'],
        'enqueueFormationCriterionCommand' | 'enqueueGroupSessionCleanup'
    >;
    readonly rtcRttInboxService: Pick<ApiV1Runtime['rtcRttInboxService'], 'enqueue'>;
    readonly appCrdtInboxService?: object;
    readonly backgroundTasks: Pick<ApiV1Runtime['backgroundTasks'], 'register'>;
    readonly groupStateService: Pick<ApiV1Runtime['groupStateService'], 'observeSnapshot' | 'readSnapshotAtLeast'>;
    readonly clientStateService: Pick<ApiV1Runtime['clientStateService'], 'observeSnapshot'>;
    readonly outboxQueueReader: object;
    readonly qboxEngine: Pick<ApiV1Runtime['qboxEngine'], 'wake'>;
    readonly rtcTopologyReplay: Pick<ApiV1Runtime['rtcTopologyReplay'], 'wake'>;
    readonly rtcTopologyExecutionRepository: object;
    readonly rtcTopologyDelivery: object;
}

export interface ApiV1SystemInstallers<Runtime extends ApiV1SystemInstallerRuntime> {
    readonly installDefaultMiddlewareTopics: (
        runtime: Runtime,
        ws: RallarServerWsRouter
    ) => void;
    readonly installWebSocketLifecycle: (
        runtime: Runtime,
        ws: RallarServerWsRouter
    ) => void;
}

export interface ApiV1RtcRttTopicLifecycle {
    stop(): void;
}

export interface ApiV1SystemInstallerOperations<
    Runtime extends ApiV1SystemInstallerRuntime = ApiV1Runtime,
    Topology extends ApiV1SystemInstallerTopology = ApiV1TopologyServices,
> {
    readonly installStateSyncTopics: (
        service: Runtime['wsQBoxServerService'],
        options: ApiV1SystemTopicOptions<Runtime, Topology>
    ) => void;
    readonly installTopologyAppOutbox: (
        options: ApiV1SystemTopicOptions<Runtime, Topology>
    ) => RtcTopologyWorkPublisher;
    readonly installTopologyTopics: (
        service: Runtime['wsQBoxServerService']
    ) => void;
    readonly installChatTopic: (
        service: Runtime['wsQBoxServerService']
    ) => void;
    readonly installRtcSignalingTopic: (
        service: Runtime['wsQBoxServerService']
    ) => void;
    readonly installRtcRttTopic: (
        service: Runtime['wsQBoxServerService'],
        options: ApiV1SystemTopicOptions<Runtime, Topology>,
        topologyWorkPublisher: RtcTopologyWorkPublisher
    ) => ApiV1RtcRttTopicLifecycle;
    readonly createCrdtMutationIngress: (
        appCrdt: NonNullable<Runtime['appCrdtInboxService']>
    ) => RallarCrdtServerMutationIngress;
    readonly installCrdtTopics: typeof installRallarCrdtWsTopics;
    readonly installRouter: (router: RallarServerWsRouter) => void;
    readonly initWebSocketLifecycle: (
        service: Runtime['wsQBoxServerService'],
        handlers: Parameters<typeof initWsLifecycle>[1]
    ) => ReturnType<typeof initWsLifecycle>;
    readonly scheduleWebSocketLifecycleRetry: typeof scheduleWsLifecycleRetry;
}

export function createApiV1SystemInstallers(
    input: CreateApiV1SystemInstallersInput
): RallarServerSystemInstallers<ApiV1Runtime> {
    return constructApiV1SystemInstallers<ApiV1Runtime, ApiV1TopologyServices>(
        input,
        PRODUCTION_OPERATIONS
    );
}

export function constructApiV1SystemInstallers<
    Runtime extends ApiV1SystemInstallerRuntime,
    Topology extends ApiV1SystemInstallerTopology,
>(
    input: CreateApiV1SystemInstallersInput<Topology>,
    operations: ApiV1SystemInstallerOperations<Runtime, Topology>
): ApiV1SystemInstallers<Runtime> {
    let stopSystemTopics: (() => void) | undefined;
    return {
        installDefaultMiddlewareTopics: (runtime, ws) => {
            stopSystemTopics?.();
            const appCrdtInboxService = runtime.appCrdtInboxService;
            if (!appCrdtInboxService) {
                throw new Error('CRDT websocket topics require AppInbox mutation ingress');
            }
            const wsService = runtime.wsQBoxServerService;
            const topicOptions = createSystemTopicOptions(input, runtime);

            operations.installStateSyncTopics(wsService, topicOptions);
            const topologyWorkPublisher = operations.installTopologyAppOutbox(topicOptions);
            operations.installTopologyTopics(wsService);
            operations.installChatTopic(wsService);
            operations.installRtcSignalingTopic(wsService);
            const rtcRttRuntime = operations.installRtcRttTopic(
                wsService,
                topicOptions,
                topologyWorkPublisher
            );
            operations.installCrdtTopics(ws, {
                logRepository: input.crdtLogRepository,
                mutationIngress: operations.createCrdtMutationIngress(appCrdtInboxService),
                allowPrincipalDocuments: true,
                allowAppDocuments: true,
                policies: input.crdtPolicies
            });
            operations.installRouter(ws);

            const unregister = runtime.backgroundTasks.register(rtcRttRuntime.stop);
            stopSystemTopics = () => {
                unregister();
                rtcRttRuntime.stop();
            };
        },
        installWebSocketLifecycle: (runtime) => {
            const lifecycle = operations.initWebSocketLifecycle(
                runtime.wsQBoxServerService,
                {
                    now: input.nowEpochMs,
                    enqueueClientSessionDisconnect: (close) =>
                        runtime.appClientInboxService.enqueueAuthorisedWsClientDisconnect(
                            wsRoutes.toAuthorisedWsClientDisconnectInput(close)
                        ),
                    enqueueGroupSessionCleanup: (close) =>
                        runtime.groupStateInboxService.enqueueGroupSessionCleanup(
                            wsRoutes.toGroupPresenceSessionCleanupInput(close)
                        ),
                    hasCloseFacts: wsRoutes.hasAuthorisedWsCloseFacts,
                    releaseCloseFacts: wsRoutes.releaseAuthorisedWsCloseFacts,
                    retry: {
                        delaysMs: [
                            ...DEFAULT_RESOURCE_INBOX_RETRY_POLICY.delaysAfterAttemptMs,
                            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxDelayMs
                        ],
                        schedule: operations.scheduleWebSocketLifecycleRetry
                    }
                }
            );
            runtime.backgroundTasks.register(lifecycle.stop);
        }
    };
}

function submitFormationCriterionCommand(
    runtime: ApiV1SystemInstallerRuntime,
    command: Parameters<ApiV1Runtime['groupStateInboxService']['enqueueFormationCriterionCommand']>[0],
    atEpochMs: number
): Promise<void> {
    return runtime.groupStateInboxService.enqueueFormationCriterionCommand(command, atEpochMs);
}

function createSystemTopicOptions<
    Runtime extends ApiV1SystemInstallerRuntime,
    Topology extends ApiV1SystemInstallerTopology,
>(
    input: CreateApiV1SystemInstallersInput<Topology>,
    runtime: Runtime
): ApiV1SystemTopicOptions<Runtime, Topology> {
    const topology = input.topology;
    return {
        rtcTopologyService: topology.rtcTopologyService,
        rtcTopologyOptions: topology.rtcTopologyOptions,
        topologyQuery: topology.topologyQuery,
        topologyPlanning: topology.topologyPlanning,
        rttRefinementGate: topology.rttRefinementGate,
        rttRefinementService: topology.rttRefinementService,
        observeGroupSnapshot: async (snapshot) => {
            await runtime.groupStateService.observeSnapshot(snapshot);
        },
        observeClientSnapshot: async (snapshot) => {
            await runtime.clientStateService.observeSnapshot(snapshot);
        },
        rtcRttRuntimeState: {
            topologyConfig: topology.topologyConfigRepository,
            groupState: topology.groupStateRepository,
            topologySnapshots: topology.topologySnapshotRepository,
            rtts: topology.rttRepository
        },
        globalGraphRecomputeLimit: input.globalGraphRecomputeLimit,
        rtcTopologyAppOutbox: {
            database: input.database,
            outboxQueueReader: runtime.outboxQueueReader,
            senderId: input.serviceId,
            wake: () => runtime.qboxEngine.wake(),
            wakeReplay: () => runtime.rtcTopologyReplay.wake('local-commit'),
            executionRepository: runtime.rtcTopologyExecutionRepository,
            topologyDelivery: runtime.rtcTopologyDelivery,
            findGroupSnapshotByRef: (ref, cacheOptions) =>
                runtime.groupStateService.readSnapshotAtLeast(ref, cacheOptions ?? {}),
            formationCriterion: {
                readLifecyclePolicy: (ref) => topology.groupStateRepository.readLifecyclePolicy(ref),
                submitCommand: (command, atEpochMs) => submitFormationCriterionCommand(runtime, command, atEpochMs)
            }
        },
        enqueueRtcRttMutation: (enqueue) => runtime.rtcRttInboxService.enqueue(enqueue)
    };
}

export interface ApiV1SystemTopicOptions<
    Runtime extends ApiV1SystemInstallerRuntime,
    Topology extends ApiV1SystemInstallerTopology,
> extends InstallStateSyncWsTopicsOptions {
    readonly rtcTopologyService: Topology['rtcTopologyService'];
    readonly rtcTopologyOptions: Topology['rtcTopologyOptions'];
    readonly topologyQuery: Topology['topologyQuery'];
    readonly topologyPlanning: Topology['topologyPlanning'];
    readonly rttRefinementGate: Topology['rttRefinementGate'];
    readonly rttRefinementService: Topology['rttRefinementService'];
    readonly rtcRttRuntimeState: ApiV1SystemTopologyRepositories<Topology>;
    readonly rtcTopologyAppOutbox: ApiV1RtcTopologyAppOutboxOptions<Runtime>;
    readonly globalGraphRecomputeLimit: InstallRtcRttSystemTopicOptions['globalGraphRecomputeLimit'];
    readonly enqueueRtcRttMutation: InstallRtcRttSystemTopicOptions['enqueueMutation'];
}

export interface ApiV1SystemTopologyRepositories<Topology extends ApiV1SystemInstallerTopology> {
    readonly topologyConfig: Topology['topologyConfigRepository'];
    readonly groupState: Topology['groupStateRepository'];
    readonly topologySnapshots: Topology['topologySnapshotRepository'];
    readonly rtts: Topology['rttRepository'];
}

export interface ApiV1RtcTopologyAppOutboxOptions<Runtime extends ApiV1SystemInstallerRuntime>
    extends
        Omit<
            InstallTopologyAppOutboxOptions,
            | 'executionRepository'
            | 'outboxQueueReader'
            | 'topologyDelivery'
            | 'topologyQuery'
            | 'topologyPlanning'
            | 'rttRefinementService'
            | 'nowEpochMs'
        > {
    readonly outboxQueueReader: Runtime['outboxQueueReader'];
    readonly executionRepository: Runtime['rtcTopologyExecutionRepository'];
    readonly topologyDelivery: Runtime['rtcTopologyDelivery'];
}

const PRODUCTION_OPERATIONS: ApiV1SystemInstallerOperations<ApiV1Runtime, ApiV1TopologyServices> = {
    installStateSyncTopics: (service, options) => {
        installStateSyncWsTopics(service, options);
    },
    installTopologyAppOutbox: (options) =>
        installTopologyAppOutbox({
            ...options.rtcTopologyAppOutbox,
            topologyQuery: options.topologyQuery,
            topologyPlanning: options.topologyPlanning,
            rttRefinementService: options.rttRefinementService,
            nowEpochMs: options.rtcTopologyOptions.now ?? Date.now
        }),
    installTopologyTopics: installTopologyWsTopics,
    installChatTopic: installChatWsTopic,
    installRtcSignalingTopic: installRtcSignalingWsTopic,
    installRtcRttTopic: (service, options, topologyWorkPublisher) =>
        installRtcRttSystemTopic(service, {
            service: options.rtcTopologyService,
            serviceOptions: options.rtcTopologyOptions,
            topologyQuery: options.topologyQuery,
            refinementGate: options.rttRefinementGate,
            topologyWorkPublisher,
            runtimeState: options.rtcRttRuntimeState,
            findGroupSnapshotByRef: options.rtcTopologyAppOutbox.findGroupSnapshotByRef,
            globalGraphRecomputeLimit: options.globalGraphRecomputeLimit,
            enqueueMutation: options.enqueueRtcRttMutation
        }),
    createCrdtMutationIngress: createCrdtWsMutationIngress,
    installCrdtTopics: installRallarCrdtWsTopics,
    installRouter: (router) => router.install(),
    initWebSocketLifecycle: initWsLifecycle,
    scheduleWebSocketLifecycleRetry: scheduleWsLifecycleRetry
};
