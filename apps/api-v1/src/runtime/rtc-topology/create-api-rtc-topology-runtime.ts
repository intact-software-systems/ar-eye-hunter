import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import {
  PSqlRtcTopologyDeliveryRepository,
} from '@shared-server/postgres/rtc-topology/p-sql-rtc-topology-delivery-repository.ts';
import {
  PSqlRtcTopologyReplayRepository,
} from '@shared-server/postgres/rtc-topology/p-sql-rtc-topology-replay-repository.ts';
import {
  createRtcTopologyPublicationFanout,
  type RtcTopologyPublicationFanout,
} from '@shared-server/rallar-system/pubsub/RtcTopologyClusterTransport.ts';
import {
  DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS,
  RtcTopologyPublicationRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts';
import {
  RtcTopologyExecutionRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts';
import {
  RtcTopologySnapshotRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts';
import {
  createRtcTopologyReplayDiagnostics,
  type RtcTopologyReplayMetrics,
  type RtcTopologyReplayWakeSource,
} from '@shared-server/rallar-system/topology/replay/rtc-topology-replay-diagnostics.ts';
import {
  RtcTopologyReplayEntryHandlerService,
} from '@shared-server/rallar-system/topology/replay/rtc-topology-replay-entry-handler.ts';
import type {
  RuntimeStateOptimisticTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';

import {
  createApiV1RtcTopologyClusterTransport,
} from '../../db/api-v1-rtc-topology-cluster-transport.ts';
import type { ApiV1DatabasePubSubConfig } from '../../db/database-pubsub-config.ts';
import {
  startApiRtcTopologyDelivery,
} from './rtc-topology-delivery-startup.ts';
import type { RtcTopologyReplayMode } from './rtc-topology-replay-config.ts';
import { startApiRtcTopologyReplay } from './rtc-topology-replay-startup.ts';

interface CreateApiRtcTopologyRuntimeInput {
  readonly database: PSqlSql;
  readonly runtimeStateRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
  readonly pubSubConfig: ApiV1DatabasePubSubConfig;
  readonly webSocketServer: JsonWebSocketServer;
  readonly publisherId: string;
  readonly publisherStreamId: string;
  readonly nowEpochMs: () => number;
  readonly onCompactionFailure: (error: Error) => void;
  readonly replayMode: RtcTopologyReplayMode;
}

export interface ApiRtcTopologyRuntime {
  readonly publicationRepository: RtcTopologyPublicationRepository;
  readonly executionRepository: RtcTopologyExecutionRepository;
  readonly publicationFanout: RtcTopologyPublicationFanout;
  readonly topologyDelivery: Readonly<{
    publisherStreamId: string;
    append: PSqlRtcTopologyDeliveryRepository;
  }>;
  readonly readiness: Promise<void>;
  readonly healthFailure: Promise<never>;
  readonly topologyReplay: Readonly<{
    attach(input: Readonly<{
      wsQueueBoxServerService: WsQueueBoxServerService;
      hydrateGap: (signal: AbortSignal) => Promise<void>;
    }>): void;
    wake(source: RtcTopologyReplayWakeSource): void;
    readMetrics(): RtcTopologyReplayMetrics;
    resetMetrics(): void;
  }>;
  stop(): Promise<void>;
}

export function createApiRtcTopologyRuntime(
  input: CreateApiRtcTopologyRuntimeInput,
): ApiRtcTopologyRuntime {
  const publicationRepository = new RtcTopologyPublicationRepository(
    input.runtimeStateRepository,
    DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS,
    input.nowEpochMs,
  );
  const executionRepository = new RtcTopologyExecutionRepository(
    input.runtimeStateRepository,
    DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS,
    input.nowEpochMs,
  );
  const publicationFanout = createRtcTopologyPublicationFanout({
    publisherId: input.publisherId,
    repository: publicationRepository,
    transport: createApiV1RtcTopologyClusterTransport(
      input.pubSubConfig,
      input.publisherId,
    ),
    server: input.webSocketServer,
  });
  const deliveryRepository = new PSqlRtcTopologyDeliveryRepository(input.database);
  const replayRepository = new PSqlRtcTopologyReplayRepository(input.database);
  const replayDiagnostics = createRtcTopologyReplayDiagnostics();
  const delivery = startApiRtcTopologyDelivery({
    streamId: input.publisherStreamId,
    repository: {
      registerStream: (registration) => deliveryRepository.registerStream(registration),
      renewStreamLease: (renewal) => deliveryRepository.renewStreamLease(renewal),
      compactExpiredEntries: (compaction) =>
        deliveryRepository.compactExpiredEntries(compaction),
      retireExpiredConsumerCursors: (retirement) =>
        replayRepository.retireExpiredConsumerCursors(retirement),
      retireEmptyStreams: (retirement) => replayRepository.retireEmptyStreams(retirement),
    },
    onCompactionFailure: input.onCompactionFailure,
  });
  const replay = startApiRtcTopologyReplay({
    mode: input.replayMode,
    consumerStreamId: input.publisherStreamId,
    repository: replayRepository,
    diagnostics: replayDiagnostics.record,
    startupBarrier: delivery.readiness,
  });
  return {
    publicationRepository,
    executionRepository,
    publicationFanout,
    topologyDelivery: {
      publisherStreamId: input.publisherStreamId,
      append: deliveryRepository,
    },
    readiness: Promise.all([
      publicationFanout.readiness,
      delivery.readiness,
      replay.readiness,
    ]).then(() => undefined),
    healthFailure: Promise.race([
      delivery.healthFailure,
      replay.healthFailure,
    ]),
    topologyReplay: {
      attach: ({ wsQueueBoxServerService, hydrateGap }) => {
        replay.attach({
          entryHandler: new RtcTopologyReplayEntryHandlerService({
            publications: publicationRepository,
            outbox: wsQueueBoxServerService.outbox,
            snapshots: new RtcTopologySnapshotRepository(input.runtimeStateRepository),
            sender: wsQueueBoxServerService,
          }),
          hydrateGap,
        });
      },
      wake: replay.wake,
      readMetrics: replayDiagnostics.readMetrics,
      resetMetrics: replayDiagnostics.resetMetrics,
    },
    stop: async () => {
      delivery.stop();
      await replay.stop();
    },
  };
}
