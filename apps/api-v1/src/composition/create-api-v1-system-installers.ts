import type {
  RallarCrdtAdminLogRepository,
  RallarCrdtDocumentTypePolicy,
} from '@shared/crdt/mod.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import {
  installRallarCrdtWsTopics,
  type RallarCrdtServerMutationIngress,
} from '@shared-server/crdt/RallarCrdtServer.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import type { RallarServerSystemInstallers } from '@shared-server/rallar-facade/RallarServer.ts';
import {
  initWsLifecycle,
  scheduleWsLifecycleRetry,
} from '@shared-server/rallar-system/services/ws-lifecycle-service.ts';
import {
  initRallarSystemWsTopics,
  type InitRallarSystemWsTopicsOptions,
} from '@shared-server/rallar-system/ws-system-topics.ts';

import { createCrdtWsMutationIngress } from '../services/create-crdt-ws-mutation-ingress.ts';
import * as wsRoutes from '../routes/ws-routes.ts';
import type { ApiV1Runtime } from './api-v1-runtime.ts';
import type { ApiV1TopologyServices } from './create-api-v1-topology-services.ts';

export interface CreateApiV1SystemInstallersInput {
  readonly database: PSqlSql;
  readonly serviceId: string;
  readonly nowEpochMs: () => number;
  readonly topology: ApiV1TopologyServices;
  readonly crdtLogRepository: RallarCrdtAdminLogRepository;
  readonly crdtPolicies: readonly RallarCrdtDocumentTypePolicy[] | undefined;
  readonly globalGraphRecomputeLimit: InitRallarSystemWsTopicsOptions['globalGraphRecomputeLimit'];
}

export interface ApiV1SystemInstallerOperations {
  initialiseSystemTopics: typeof initRallarSystemWsTopics;
  createCrdtMutationIngress(
    appCrdt: NonNullable<ApiV1Runtime['appCrdtInboxService']>,
    serviceId: string,
  ): RallarCrdtServerMutationIngress;
  installCrdtTopics: typeof installRallarCrdtWsTopics;
  initWebSocketLifecycle: typeof initWsLifecycle;
  scheduleWebSocketLifecycleRetry: typeof scheduleWsLifecycleRetry;
}

export function createApiV1SystemInstallers(
  input: CreateApiV1SystemInstallersInput,
): RallarServerSystemInstallers<ApiV1Runtime> {
  return constructApiV1SystemInstallers(input, PRODUCTION_OPERATIONS);
}

export function constructApiV1SystemInstallers(
  input: CreateApiV1SystemInstallersInput,
  operations: ApiV1SystemInstallerOperations,
): RallarServerSystemInstallers<ApiV1Runtime> {
  let stopSystemTopics: (() => void) | undefined;
  return {
    installDefaultMiddlewareTopics: (runtime, ws) => {
      stopSystemTopics?.();
      const systemTopics = operations.initialiseSystemTopics(
        runtime.wsQBoxServerService,
        createSystemTopicOptions(input, runtime),
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
        mutationIngress: operations.createCrdtMutationIngress(
          appCrdtInboxService,
          input.serviceId,
        ),
        allowPrincipalDocuments: true,
        allowAppDocuments: true,
        policies: input.crdtPolicies,
      });
    },
    installWebSocketLifecycle: (runtime) => {
      const lifecycle = operations.initWebSocketLifecycle(
        runtime.wsQBoxServerService,
        {
          now: input.nowEpochMs,
          enqueueClientSessionDisconnect: (close) =>
            runtime.appClientInboxService.enqueueAuthorisedWsClientDisconnect(
              wsRoutes.toAuthorisedWsClientDisconnectInput(close),
            ),
          enqueueGroupSessionCleanup: (close) =>
            runtime.appGroupInboxService.enqueueGroupSessionCleanup(
              wsRoutes.toGroupPresenceSessionCleanupInput(close),
            ),
          hasCloseFacts: wsRoutes.hasAuthorisedWsCloseFacts,
          releaseCloseFacts: wsRoutes.releaseAuthorisedWsCloseFacts,
          retry: {
            delaysMs: [
              ...DEFAULT_RESOURCE_INBOX_RETRY_POLICY.delaysAfterAttemptMs,
              DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxDelayMs,
            ],
            schedule: operations.scheduleWebSocketLifecycleRetry,
          },
        },
      );
      runtime.backgroundTasks.register(lifecycle.stop);
    },
  };
}

function submitFormationCriterionCommand(
  runtime: ApiV1Runtime,
  command: Parameters<ApiV1Runtime['appGroupInboxService']['enqueueFormationCriterionCommand']>[0],
  atEpochMs: number,
): Promise<void> {
  return runtime.appGroupInboxService.enqueueFormationCriterionCommand(command, atEpochMs);
}

function createSystemTopicOptions(
  input: CreateApiV1SystemInstallersInput,
  runtime: ApiV1Runtime,
): InitRallarSystemWsTopicsOptions {
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
      rtts: topology.rttRepository,
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
        submitCommand: (command, atEpochMs) =>
          submitFormationCriterionCommand(runtime, command, atEpochMs),
      },
    },
    enqueueRtcRttMutation: (enqueue) => runtime.appGroupInboxService.enqueueRtcRtt(enqueue),
  };
}

const PRODUCTION_OPERATIONS: ApiV1SystemInstallerOperations = {
  initialiseSystemTopics: initRallarSystemWsTopics,
  createCrdtMutationIngress: createCrdtWsMutationIngress,
  installCrdtTopics: installRallarCrdtWsTopics,
  initWebSocketLifecycle: initWsLifecycle,
  scheduleWebSocketLifecycleRetry: scheduleWsLifecycleRetry,
};
