import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { RallarServerApplicationSystemInstallers } from '@shared-server/rallar-server/rallar-server-application.ts';
import { installRtcSignalingWsTopic } from '@shared-server/rallar-system/communication/install-rtc-signaling-ws-topic.ts';
import { createCrdtWsMutationIngress } from '@shared-server/rallar-system/crdt/inbox/create-crdt-ws-mutation-ingress.ts';
import { installRallarCrdtWsTopics } from '@shared-server/rallar-system/crdt/realtime/install-rallar-crdt-ws-topics.ts';
import { GroupConnectTriggerLatchRepository } from '@shared-server/rallar-system/group-state/persistence/group-connect-trigger-latch-repository.ts';
import { installRtcRttSystemTopic } from '@shared-server/rallar-system/rtc-rtt/topic/install-rtc-rtt-system-topic.ts';
import {
    installTopologyAppOutbox,
    type InstallTopologyAppOutboxOptions
} from '@shared-server/rallar-system/topology/runtime/install-topology-app-outbox.ts';
import type { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import {
    initWsLifecycle,
    scheduleWsLifecycleRetry
} from '@shared-server/rallar-system/websocket/ws-lifecycle-service.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { RallarCrdtAdminReadRepository, RallarCrdtDocumentTypePolicy } from '@shared/crdt/mod.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';

import * as wsRoutes from '../routes/ws-routes.ts';
import type { ApiV1Runtime } from './api-v1-runtime.ts';
import type { ApiV1TopologyServices } from './create-api-v1-topology-services.ts';

export interface CreateApiV1SystemInstallersInput {
    readonly database: PSqlSql;
    readonly serviceId: string;
    readonly nowEpochMs: () => number;
    readonly topology: ApiV1TopologyServices;
    readonly crdtLogRepository: RallarCrdtAdminReadRepository;
    readonly crdtPolicies: readonly RallarCrdtDocumentTypePolicy[];
}

export function createApiV1SystemInstallers(
    input: CreateApiV1SystemInstallersInput
): RallarServerApplicationSystemInstallers<ApiV1Runtime> {
    return {
        installSystemTopics: (runtime, ws) => installApiV1SystemTopics(input, runtime, ws),
        installWebSocketLifecycle: (runtime) => installApiV1WebSocketLifecycle(input, runtime)
    };
}

function installApiV1SystemTopics(
    input: CreateApiV1SystemInstallersInput,
    runtime: ApiV1Runtime,
    ws: RallarServerWsRouter
): void {
    const appCrdtInboxService = runtime.appCrdtInboxService;
    if (!appCrdtInboxService) {
        throw new Error('CRDT websocket topics require AppInbox mutation ingress');
    }

    installTopologyAppOutbox(createTopologyAppOutboxOptions(input, runtime));
    installRtcSignalingWsTopic(runtime.wsQBoxServerService);
    installRtcRttSystemTopic(runtime.wsQBoxServerService, {
        enqueueMutation: (enqueue) => runtime.rtcRttInboxService.enqueue(enqueue)
    });
    installRallarCrdtWsTopics(ws, {
        logRepository: input.crdtLogRepository,
        mutationIngress: createCrdtWsMutationIngress(appCrdtInboxService),
        allowPrincipalDocuments: true,
        allowAppDocuments: true,
        policies: input.crdtPolicies
    });
    ws.install();
}

function createTopologyAppOutboxOptions(
    input: CreateApiV1SystemInstallersInput,
    runtime: ApiV1Runtime
): InstallTopologyAppOutboxOptions {
    const topology = input.topology;
    return {
        database: input.database,
        outboxQueueReader: runtime.outboxQueueReader,
        senderId: input.serviceId,
        wake: () => runtime.qboxEngine.wake(),
        wakeReplay: () => runtime.rtcTopologyReplay.wake('local-commit'),
        findGroupSnapshotByRef: (ref, cacheOptions) =>
            runtime.groupStateService.readSnapshotAtLeast(ref, cacheOptions ?? {}),
        executionRepository: runtime.rtcTopologyExecutionRepository,
        readPlannedTopologySnapshot: async (ref) => await topology.topologySnapshotRepository.findSnapshot(ref),
        topologyPlanning: topology.topologyPlanning,
        rttRefinementService: topology.rttRefinementService,
        topologyDelivery: runtime.rtcTopologyDelivery,
        nowEpochMs: topology.rtcTopologyOptions.now ?? Date.now,
        formationAutomation: {
            latches: new GroupConnectTriggerLatchRepository(new PSqlRuntimeStateRepository(input.database)),
            readGroup: async (ref) => (await topology.groupStateRepository.readSnapshot(ref))?.group ?? null,
            readPlanned: async (ref) => await topology.topologySnapshotRepository.findSnapshot(ref) ?? null,
            submitCommand: (command, atEpochMs) =>
                runtime.groupStateInboxService.enqueueFormationAutomationCommand(command, atEpochMs),
            nowEpochMs: topology.rtcTopologyOptions.now ?? Date.now
        },
        formationCriterion: {
            deferred: {
                minIntervalMs: 1_000,
                nowEpochMs: input.nowEpochMs,
                schedule: (delayMs, callback) => {
                    setTimeout(() => {
                        void callback();
                    }, delayMs);
                }
            },
            readLifecyclePolicy: (ref) => topology.groupStateRepository.readLifecyclePolicy(ref),
            submitCommand: (command, atEpochMs) =>
                runtime.groupStateInboxService.enqueueFormationCriterionCommand(command, atEpochMs)
        },
        topologyPublication: {
            readLifecyclePolicy: (ref) => topology.groupStateRepository.readLifecyclePolicy(ref),
            // Durable, never the snapshot cache: the mint gate's stage and
            // accepted-identity facts must not lag a cross-server write.
            findCurrentGroup: async (ref) => {
                const snapshot = await topology.groupStateRepository.readSnapshot(ref);
                return snapshot?.group ?? null;
            },
            submitCommand: (command, atEpochMs) =>
                runtime.groupStateInboxService.enqueueTopologyPublicationCommand(command, atEpochMs)
        }
    };
}

function installApiV1WebSocketLifecycle(
    input: CreateApiV1SystemInstallersInput,
    runtime: ApiV1Runtime
): void {
    const lifecycle = initWsLifecycle(runtime.wsQBoxServerService, {
        now: input.nowEpochMs,
        enqueueClientSessionDisconnect: async (close) => {
            await runtime.appClientInboxService.enqueueAuthorisedWsClientDisconnect(
                wsRoutes.toAuthorisedWsClientDisconnectInput(close)
            );
        },
        enqueueGroupSessionCleanup: async (close) => {
            await runtime.groupStateInboxService.enqueueGroupSessionCleanup(
                wsRoutes.toGroupPresenceSessionCleanupInput(close)
            );
        },
        hasCloseFacts: wsRoutes.hasAuthorisedWsCloseFacts,
        releaseCloseFacts: wsRoutes.releaseAuthorisedWsCloseFacts,
        retry: {
            delaysMs: [
                ...DEFAULT_RESOURCE_INBOX_RETRY_POLICY.delaysAfterAttemptMs,
                DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxDelayMs
            ],
            schedule: scheduleWsLifecycleRetry
        }
    });
    runtime.backgroundTasks.register(() => lifecycle.stop());
}
