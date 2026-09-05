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
    type RtcTopologyReplayDiagnosticsSink,
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
import type { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import type {
    ApiV1TopologyDeliveryConfiguration,
    ApiV1TopologyReplayConfiguration
} from '../../configuration/api-v1-configuration.ts';
import { startApiRtcTopologyDelivery, type ApiRtcTopologyDeliveryLifecycle } from './rtc-topology-delivery-startup.ts';
import { startApiRtcTopologyReplay, type ApiRtcTopologyReplayLifecycle } from './rtc-topology-replay-startup.ts';

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
    readonly topologyReplay: ApiRtcTopologyReplay;

    stop(): Promise<void>;
}

export interface ApiRtcTopologyReplay {
    attach(input: ApiRtcTopologyReplayAttachment): void;
    wake(source: RtcTopologyReplayWakeSource): void;
    readMetrics(): RtcTopologyReplayMetrics;
    resetMetrics(): void;
}

export interface ApiRtcTopologyReplayAttachment {
    readonly wsQueueBoxServerService: WsQueueBoxServerService;
}

interface ApiRtcHydrationResources {
    readonly topologySnapshots: RtcTopologySnapshotRepository;
    readonly acceptedTopologySnapshots: RtcTopologySnapshotRepository;
    readonly reconnectHydrator: RtcTopologyReconnectHydrator;
}

interface ApiRtcDeliveryRepositories {
    readonly delivery: PSqlRtcTopologyDeliveryRepository;
    readonly replay: PSqlRtcTopologyReplayRepository;
}

interface ApiRtcReplayResources extends ApiRtcHydrationResources {
    readonly publicationRepository: RtcTopologyPublicationRepository;
    readonly replay: ApiRtcTopologyReplayLifecycle;
}

export function createApiRtcTopologyRuntime(
    input: CreateApiRtcTopologyRuntimeInput
): ApiRtcTopologyRuntime {
    const publicationRepository = new RtcTopologyPublicationRepository(input.runtimeStateRepository);
    const executionRepository = new RtcTopologyExecutionRepository(
        input.runtimeStateRepository,
        input.delivery.publicationRetentionMs,
        input.nowEpochMs
    );
    const deliveryRepository = new PSqlRtcTopologyDeliveryRepository(input.database);
    const replayRepository = new PSqlRtcTopologyReplayRepository(input.database);
    const replayDiagnostics = createRtcTopologyReplayDiagnostics();
    const { topologySnapshots, acceptedTopologySnapshots, reconnectHydrator } = createHydrationResources(
        input,
        replayDiagnostics.record
    );
    const delivery = startTopologyDelivery(input, { delivery: deliveryRepository, replay: replayRepository });
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
        readiness: Promise.all([delivery.readiness, replay.readiness]).then(() => undefined),
        healthFailure: Promise.race([delivery.healthFailure, replay.healthFailure]),
        topologyReplay: {
            attach: ({ wsQueueBoxServerService }) => {
                attachTopologyReplay({
                    topologySnapshots,
                    acceptedTopologySnapshots,
                    reconnectHydrator,
                    publicationRepository,
                    replay
                }, wsQueueBoxServerService);
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

function createHydrationResources(
    input: CreateApiRtcTopologyRuntimeInput,
    diagnostics: RtcTopologyReplayDiagnosticsSink
): ApiRtcHydrationResources {
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
        diagnostics
    });
    if (input.replay.mode === 'enabled') {
        reconnectHydrator.start();
    }
    return { topologySnapshots, acceptedTopologySnapshots, reconnectHydrator };
}

function startTopologyDelivery(
    input: CreateApiRtcTopologyRuntimeInput,
    repositories: ApiRtcDeliveryRepositories
): ApiRtcTopologyDeliveryLifecycle {
    return startApiRtcTopologyDelivery({
        streamId: input.publisherStreamId,
        repository: {
            registerStream: (registration) => repositories.delivery.registerStream(registration),
            renewStreamLease: (renewal) => repositories.delivery.renewStreamLease(renewal),
            compactExpiredEntries: (compaction) => repositories.delivery.compactExpiredEntries(compaction),
            retireExpiredConsumerCursors: (retirement) => repositories.replay.retireExpiredConsumerCursors(retirement),
            retireEmptyStreams: (retirement) => repositories.replay.retireEmptyStreams(retirement)
        },
        configuration: input.delivery,
        onCompactionFailure: input.onCompactionFailure
    });
}

function attachTopologyReplay(resources: ApiRtcReplayResources, sender: WsQueueBoxServerService): void {
    resources.replay.attach({
        entryHandler: new RtcTopologyReplayEntryHandlerService({
            publications: resources.publicationRepository,
            outbox: sender.outbox,
            snapshots: resources.topologySnapshots,
            acceptedSnapshots: resources.acceptedTopologySnapshots,
            sender
        }),
        hydrateGap: async (signal) => await resources.reconnectHydrator.hydrateOpenConnections(signal)
    });
}
