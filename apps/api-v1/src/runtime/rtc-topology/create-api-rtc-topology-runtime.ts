import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { type GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import {
    RtcTopologyExecutionRepository
} from '@shared-server/rallar-system/topology/persistence/rtc-topology-execution-repository.ts';
import {
    RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE,
    RtcTopologySnapshotRepository
} from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { RtcTopologyPublicationRepository } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository.ts';
import {
    createRtcTopologyReplayDiagnostics,
    type RtcTopologyReplayMetrics,
    type RtcTopologyReplayWakeSource
} from '@shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-diagnostics.ts';
import {
    RtcTopologyReplayEntryHandlerService
} from '@shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.ts';
import type {
    RtcTopologyDeliveryRuntime
} from '@shared-server/rallar-system/topology/replay/delivery/rtc-topology-delivery-runtime.ts';
import type { RtcTopologyHydrationIdentity } from '@shared-server/rallar-system/topology/replay/hydration/rtc-topology-reconnect-hydration.ts';
import {
    RtcTopologyReconnectHydrator
} from '@shared-server/rallar-system/topology/replay/hydration/rtc-topology-reconnect-hydrator.ts';
import {
    PSqlRtcTopologyDeliveryRepository
} from '@shared-server/rallar-system/topology/replay/postgres/p-sql-rtc-topology-delivery-repository.ts';
import {
    PSqlRtcTopologyReplayRepository
} from '@shared-server/rallar-system/topology/replay/postgres/p-sql-rtc-topology-replay-repository.ts';
import type {
    RuntimeStateOptimisticTransactionalRepositoryLike
} from '@shared-server/runtime-state/runtime-state-repository.ts';
import type { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import type { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';

import type {
    ApiV1TopologyDeliveryConfiguration,
    ApiV1TopologyReplayConfiguration
} from '../../configuration/api-v1-configuration.ts';
import { startApiRtcTopologyDelivery } from './rtc-topology-delivery-startup.ts';
import { startApiRtcTopologyReplay } from './rtc-topology-replay-startup.ts';

export interface CreateApiRtcTopologyRuntimeInput {
    readonly database: PSqlSql;
    readonly runtimeStateRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
    readonly groupsRepository: Pick<GroupStateRepository, 'readSnapshot'>;
    readonly webSocketServer: JsonWebSocketServer;
    readonly publisherStreamId: string;
    readonly nowEpochMs: () => number;
    readonly onCompactionFailure: (error: Error) => void;
    readonly replay: ApiV1TopologyReplayConfiguration;
    readonly delivery: ApiV1TopologyDeliveryConfiguration;
    readonly readHydrationIdentity: (
        connection: ConnectionContext
    ) => RtcTopologyHydrationIdentity | undefined;
}

export interface ApiRtcTopologyRuntime {
    readonly publicationRepository: RtcTopologyPublicationRepository;
    readonly executionRepository: RtcTopologyExecutionRepository;
    readonly topologyDelivery: RtcTopologyDeliveryRuntime;
    readonly readiness: Promise<void>;
    readonly healthFailure: Promise<never>;
    readonly topologyReplay: Readonly<{
        attach(
            input: Readonly<{
                wsQueueBoxServerService: WsQueueBoxServerService;
            }>
        ): void;
        wake(source: RtcTopologyReplayWakeSource): void;
        readMetrics(): RtcTopologyReplayMetrics;
        resetMetrics(): void;
    }>;
    stop(): Promise<void>;
}

export function createApiRtcTopologyRuntime(
    input: CreateApiRtcTopologyRuntimeInput
): ApiRtcTopologyRuntime {
    const publicationRepository = new RtcTopologyPublicationRepository(
        input.runtimeStateRepository
    );
    const executionRepository = new RtcTopologyExecutionRepository(
        input.runtimeStateRepository,
        input.delivery.publicationRetentionMs,
        input.nowEpochMs
    );
    const deliveryRepository = new PSqlRtcTopologyDeliveryRepository(input.database);
    const replayRepository = new PSqlRtcTopologyReplayRepository(input.database);
    const replayDiagnostics = createRtcTopologyReplayDiagnostics();
    const topologySnapshots = new RtcTopologySnapshotRepository(input.runtimeStateRepository);
    const acceptedTopologySnapshots = new RtcTopologySnapshotRepository(
        input.runtimeStateRepository,
        RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE
    );
    const reconnectHydrator = new RtcTopologyReconnectHydrator({
        socket: input.webSocketServer,
        topologies: topologySnapshots,
        acceptedTopologies: acceptedTopologySnapshots,
        groups: input.groupsRepository,
        readIdentity: input.readHydrationIdentity,
        nowEpochMs: input.nowEpochMs,
        batchWindowMs: input.delivery.reconnectBatchWindowMs,
        diagnostics: replayDiagnostics.record
    });
    if (input.replay.mode === 'enabled') {
        reconnectHydrator.start();
    }
    const delivery = startApiRtcTopologyDelivery({
        streamId: input.publisherStreamId,
        repository: {
            registerStream: (registration) => deliveryRepository.registerStream(registration),
            renewStreamLease: (renewal) => deliveryRepository.renewStreamLease(renewal),
            compactExpiredEntries: (compaction) => deliveryRepository.compactExpiredEntries(compaction),
            retireExpiredConsumerCursors: (retirement) => replayRepository.retireExpiredConsumerCursors(retirement),
            retireEmptyStreams: (retirement) => replayRepository.retireEmptyStreams(retirement)
        },
        configuration: input.delivery,
        onCompactionFailure: input.onCompactionFailure
    });
    const replay = startApiRtcTopologyReplay({
        mode: input.replay.mode,
        configuration: input.delivery,
        consumerStreamId: input.publisherStreamId,
        repository: replayRepository,
        diagnostics: replayDiagnostics.record,
        startupBarrier: delivery.readiness
    });
    return {
        publicationRepository,
        executionRepository,
        topologyDelivery: {
            publisherStreamId: input.publisherStreamId,
            reader: deliveryRepository,
            append: deliveryRepository
        },
        readiness: Promise.all([
            delivery.readiness,
            replay.readiness
        ]).then(() => undefined),
        healthFailure: Promise.race([
            delivery.healthFailure,
            replay.healthFailure
        ]),
        topologyReplay: {
            attach: ({ wsQueueBoxServerService }) => {
                replay.attach({
                    entryHandler: new RtcTopologyReplayEntryHandlerService({
                        publications: publicationRepository,
                        outbox: wsQueueBoxServerService.outbox,
                        snapshots: topologySnapshots,
                        acceptedSnapshots: acceptedTopologySnapshots,
                        sender: wsQueueBoxServerService
                    }),
                    hydrateGap: async (signal) => await reconnectHydrator.hydrateOpenConnections(signal)
                });
            },
            wake: replay.wake,
            readMetrics: replayDiagnostics.readMetrics,
            resetMetrics: replayDiagnostics.resetMetrics
        },
        stop: async () => {
            delivery.stop();
            await replay.stop();
            await reconnectHydrator.stop();
        }
    };
}
