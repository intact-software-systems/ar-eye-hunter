import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import type { RallarServerSystemInstallers } from '@shared-server/rallar-facade/RallarServer.ts';
import type { RallarServerWsFacade } from '@shared-server/rallar-facade/ws-topic-router.ts';
import { installRallarCrdtWsTopics } from '@shared-server/rallar-system/crdt/realtime/install-rallar-crdt-ws-topics.ts';
import {
    type RallarCrdtServerMutationIngress
} from '@shared-server/rallar-system/crdt/realtime/rallar-crdt-server-contracts.ts';
import {
    initWsLifecycle,
    scheduleWsLifecycleRetry
} from '@shared-server/rallar-system/services/ws-lifecycle-service.ts';
import {
    initRallarSystemWsTopics,
    type InitRallarSystemWsTopicsOptions
} from '@shared-server/rallar-system/ws-system-topics.ts';
import type { RallarCrdtAdminReadRepository, RallarCrdtDocumentTypePolicy } from '@shared/crdt/mod.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';

import { createCrdtWsMutationIngress } from '@shared-server/rallar-system/crdt/inbox/\
create-crdt-ws-mutation-ingress.ts';

import * as wsRoutes from '../routes/ws-routes.ts';
import type { ApiV1Runtime } from './api-v1-runtime.ts';
import type { ApiV1TopologyServices } from './create-api-v1-topology-services.ts';

export interface ApiV1SystemInstallerTopology {
    readonly rtcTopologyService: object;
    readonly rtcTopologyOptions: ApiV1TopologyServices['rtcTopologyOptions'];
    readonly topologyManagement: object;
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
    readonly crdtPolicies: readonly RallarCrdtDocumentTypePolicy[] | undefined;
    readonly globalGraphRecomputeLimit: InitRallarSystemWsTopicsOptions['globalGraphRecomputeLimit'];
}

export interface ApiV1SystemInstallerRuntime {
    readonly wsQBoxServerService: ApiV1Runtime['wsQBoxServerService'];
    readonly appClientInboxService: Pick<ApiV1Runtime['appClientInboxService'], 'enqueueAuthorisedWsClientDisconnect'>;
    readonly appGroupInboxService: Pick<
        ApiV1Runtime['appGroupInboxService'],
        'enqueueFormationCriterionCommand' | 'enqueueGroupSessionCleanup' | 'enqueueRtcRtt'
    >;
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
        ws: RallarServerWsFacade
    ) => void;
    readonly installWebSocketLifecycle: (
        runtime: Runtime,
        ws: RallarServerWsFacade
    ) => void;
}

export interface ApiV1SystemInstallerOperations<
    Runtime extends ApiV1SystemInstallerRuntime = ApiV1Runtime,
    Topology extends ApiV1SystemInstallerTopology = ApiV1TopologyServices,
> {
    readonly initialiseSystemTopics: (
        service: Runtime['wsQBoxServerService'],
        options: ApiV1SystemTopicOptions<Runtime, Topology>
    ) => ReturnType<typeof initRallarSystemWsTopics>;
    readonly createCrdtMutationIngress: (
        appCrdt: NonNullable<Runtime['appCrdtInboxService']>
    ) => RallarCrdtServerMutationIngress;
    readonly installCrdtTopics: typeof installRallarCrdtWsTopics;
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
            const systemTopics = operations.initialiseSystemTopics(
                runtime.wsQBoxServerService,
                createSystemTopicOptions(input, runtime)
            );
            const unregister = runtime.backgroundTasks.register(systemTopics.stop);
            stopSystemTopics = () => {
                unregister();
                systemTopics.stop();
            };

            const appCrdtInboxService = runtime.appCrdtInboxService;
            if (!appCrdtInboxService) {
                throw new Error('CRDT websocket topics require AppInbox mutation ingress');
            }
            operations.installCrdtTopics(ws, {
                logRepository: input.crdtLogRepository,
                mutationIngress: operations.createCrdtMutationIngress(appCrdtInboxService),
                allowPrincipalDocuments: true,
                allowAppDocuments: true,
                policies: input.crdtPolicies
            });
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
                        runtime.appGroupInboxService.enqueueGroupSessionCleanup(
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
    command: Parameters<ApiV1Runtime['appGroupInboxService']['enqueueFormationCriterionCommand']>[0],
    atEpochMs: number
): Promise<void> {
    return runtime.appGroupInboxService.enqueueFormationCriterionCommand(command, atEpochMs);
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
        enqueueRtcRttMutation: (enqueue) => runtime.appGroupInboxService.enqueueRtcRtt(enqueue)
    };
}

export interface ApiV1SystemTopicOptions<
    Runtime extends ApiV1SystemInstallerRuntime,
    Topology extends ApiV1SystemInstallerTopology,
> extends
    Omit<
        InitRallarSystemWsTopicsOptions,
        | 'rtcTopologyAppOutbox'
        | 'rtcTopologyManagement'
        | 'rtcTopologyOptions'
        | 'rtcTopologyRepositories'
        | 'rtcTopologyService'
        | 'rttRefinementGate'
        | 'rttRefinementService'
    > {
    readonly rtcTopologyService: Topology['rtcTopologyService'];
    readonly rtcTopologyOptions: Topology['rtcTopologyOptions'];
    readonly rtcTopologyManagement: Topology['topologyManagement'];
    readonly rttRefinementGate: Topology['rttRefinementGate'];
    readonly rttRefinementService: Topology['rttRefinementService'];
    readonly rtcTopologyRepositories: ApiV1SystemTopologyRepositories<Topology>;
    readonly rtcTopologyAppOutbox: ApiV1RtcTopologyAppOutboxOptions<Runtime>;
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
            NonNullable<InitRallarSystemWsTopicsOptions['rtcTopologyAppOutbox']>,
            'executionRepository' | 'outboxQueueReader' | 'topologyDelivery'
        > {
    readonly outboxQueueReader: Runtime['outboxQueueReader'];
    readonly executionRepository: Runtime['rtcTopologyExecutionRepository'];
    readonly topologyDelivery: Runtime['rtcTopologyDelivery'];
}

const PRODUCTION_OPERATIONS: ApiV1SystemInstallerOperations<ApiV1Runtime, ApiV1TopologyServices> = {
    initialiseSystemTopics: initRallarSystemWsTopics,
    createCrdtMutationIngress: createCrdtWsMutationIngress,
    installCrdtTopics: installRallarCrdtWsTopics,
    initWebSocketLifecycle: initWsLifecycle,
    scheduleWebSocketLifecycleRetry: scheduleWsLifecycleRetry
};
