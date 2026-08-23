import { type GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { type RtcTopologyPublicationRepository } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository.ts';
import type { ALInboundRuntimeStores } from '@shared/alm/ALInboundMessageRuntime.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/ALOutboundMessageRuntime.ts';
import type { DequeueResourceEntryOptions, ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/QueueBoxTypes.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import {
    WsQueueBoxServerService,
    type WsDeliveryDiagnosticsSink,
    type WsServerTargetResolver
} from '@shared/services/WsQueueBoxServerService.ts';
import { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import type { ClientStateService } from '../client-state/client-state-service-contracts.ts';
import type { AppClientInboxService } from '../client-state/inbox/app-client-inbox-service.ts';
import type { ClientStateRepository } from '../client-state/persistence/client-state-repository.ts';
import type { GroupStateInboxService } from '../group-state/inbox/group-state-inbox-service.ts';
import type { GroupStateRepository } from '../group-state/persistence/group-state-repository.ts';
import type { RallarSnapshotPresenceClock } from '../presence/snapshot-presence.ts';
import {
    installQueueBoxPubSubBridge,
    type InstallQueueBoxPubSubBridgeOptions
} from '../queue-pubsub/queue-box-pub-sub-bridge.ts';
import type { RtcRttInboxService } from '../rtc-rtt/inbox/rtc-rtt-inbox-service.ts';
import type { TopologyInboxService } from '../topology/inbox/topology-inbox-service.ts';
import type { RtcTopologyExecutionRepository } from '../topology/persistence/rtc-topology-execution-repository.ts';
import type { RtcTopologyDeliveryAppendPort } from '../topology/replay/rtc-topology-delivery-append-port.ts';
import type {
    RtcTopologyReplayMetrics,
    RtcTopologyReplayWakeSource
} from '../topology/replay/rtc-topology-replay-diagnostics.ts';
import { initialiseServerCacheRepositories } from './cache-repositories.ts';
import type {
    RallarAdminInboxServiceFactory,
    RallarAuthInboxServiceFactory,
    RallarCrdtInboxServiceFactory,
    RallarGroupSnapshotResolverOptions
} from './rallar-middleware-options.ts';
import { createWsServerTargetResolver } from './ws-server-target-resolver.ts';
export type { RallarGroupSnapshotResolverOptions } from './rallar-middleware-options.ts';
export { createWsServerTargetResolver } from './ws-server-target-resolver.ts';
export type RtcTopologyReplayRuntime = Readonly<{
    wake(source: RtcTopologyReplayWakeSource): void;
    readMetrics(): RtcTopologyReplayMetrics;
    resetMetrics(): void;
}>;
export type RallarMiddlewareRuntime = Readonly<{
    qboxEngine: InboxOutboxEngine;
    wsQBoxServerService: WsQueueBoxServerService;
    inboxQueueReader: InboxQueueReader;
    outboxQueueReader: OutboxQueueReader;
    appInboxResilience: ResilienceDto;
    appOutboxResilience: ResilienceDto;
    groupStateInboxService: GroupStateInboxService;
    topologyInboxService: TopologyInboxService;
    rtcRttInboxService: RtcRttInboxService;
    appClientInboxService: AppClientInboxService;
    appAuthInboxService?: ReturnType<RallarAuthInboxServiceFactory>;
    appAdminInboxService?: ReturnType<RallarAdminInboxServiceFactory>;
    appCrdtInboxService?: ReturnType<RallarCrdtInboxServiceFactory>;
    clientStateService: ClientStateService;
    groupStateService: GroupStateService;
    clientsRepository: ClientStateRepository;
    groupsRepository: GroupStateRepository;
    rtcTopologyPublicationRepository?: RtcTopologyPublicationRepository;
    rtcTopologyExecutionRepository?: RtcTopologyExecutionRepository;
    rtcTopologyDelivery?: Readonly<{
        publisherStreamId: string;
        append: RtcTopologyDeliveryAppendPort;
    }>;
    rtcTopologyReplay?: RtcTopologyReplayRuntime;
    readiness: Promise<void>;
    healthFailure?: Promise<never>;
}>;
export type CreateRallarMiddlewareOptions = Readonly<{
    inbox: QueueBoxResourceEntryRepository;
    outbox?: QueueBoxResourceEntryRepository;
    appInboxDequeueOptions?: DequeueResourceEntryOptions;
    webSocketServer?: JsonWebSocketServer;
    wsRuntimeName?: string;
    targetResolver?: WsServerTargetResolver;
    findGroupSnapshotByRef?: RallarGroupSnapshotResolverOptions['findGroupSnapshotByRef'];
    findClientSnapshotByRef?: RallarGroupSnapshotResolverOptions['findClientSnapshotByRef'];
    findGroupSnapshotById?: RallarGroupSnapshotResolverOptions['findGroupSnapshotById'];
    resolveGroupRef?: RallarGroupSnapshotResolverOptions['resolveGroupRef'];
    now?: RallarSnapshotPresenceClock;
    inboundStores?: ALInboundRuntimeStores;
    outboundStores?: ALOutboundRuntimeStores;
    wsDeliveryDiagnostics?: WsDeliveryDiagnosticsSink;
    createGroupStateInboxService: (
        input: Readonly<{
            inboxQueueReader: InboxQueueReader;
            outboxQueueReader: OutboxQueueReader;
            wsQBoxServerService: WsQueueBoxServerService;
            appInboxResilience: ResilienceDto;
            appOutboxResilience: ResilienceDto;
            wakeQueueEngine: () => void;
        }>
    ) => GroupStateInboxService;
    createTopologyInboxService: (
        input: Readonly<{
            inboxQueueReader: InboxQueueReader;
            appInboxResilience: ResilienceDto;
            wakeQueueEngine: () => void;
        }>
    ) => TopologyInboxService;
    createRtcRttInboxService: (
        input: Readonly<{
            inboxQueueReader: InboxQueueReader;
            appInboxResilience: ResilienceDto;
            wakeQueueEngine: () => void;
        }>
    ) => RtcRttInboxService;
    createAppClientInboxService: (
        input: Readonly<{
            inboxQueueReader: InboxQueueReader;
            wsQBoxServerService: WsQueueBoxServerService;
            appInboxResilience: ResilienceDto;
            wakeQueueEngine: () => void;
        }>
    ) => AppClientInboxService;
    createAppAuthInboxService?: RallarAuthInboxServiceFactory;
    createAppAdminInboxService?: RallarAdminInboxServiceFactory;
    createAppCrdtInboxService?: RallarCrdtInboxServiceFactory;
    resilience: Readonly<{
        inbox: ResilienceDto;
        outbox?: ResilienceDto;
        appInbox?: ResilienceDto;
        appOutbox: ResilienceDto;
    }>;
    clientsRepository: ClientStateRepository;
    groupsRepository: GroupStateRepository;
    rtcTopologyPublicationRepository?: RtcTopologyPublicationRepository;
    rtcTopologyExecutionRepository?: RtcTopologyExecutionRepository;
    rtcTopologyDelivery?: Readonly<{
        publisherStreamId: string;
        append: RtcTopologyDeliveryAppendPort;
    }>;
    rtcTopologyReplay?: RtcTopologyReplayRuntime;
    queuePubSubBridge?: Omit<InstallQueueBoxPubSubBridgeOptions, 'wsQBoxServerService'>;
    readiness?: Promise<void>;
    healthFailure?: Promise<never>;
}>;

interface RallarMiddlewareInfrastructure {
    readonly qboxEngine: InboxOutboxEngine;
    readonly wsQBoxServerService: WsQueueBoxServerService;
    readonly inboxQueueReader: InboxQueueReader;
    readonly outboxQueueReader: OutboxQueueReader;
    readonly appInboxResilience: ResilienceDto;
    readonly appOutboxResilience: ResilienceDto;
    readonly queuePubSubBridgeReadiness: Promise<void>;
    readonly wakeQueueEngine: () => void;
}

interface RallarMiddlewareInboxServices {
    readonly groupStateInboxService: GroupStateInboxService;
    readonly topologyInboxService: TopologyInboxService;
    readonly rtcRttInboxService: RtcRttInboxService;
    readonly appClientInboxService: AppClientInboxService;
    readonly appAuthInboxService?: ReturnType<RallarAuthInboxServiceFactory>;
    readonly appAdminInboxService?: ReturnType<RallarAdminInboxServiceFactory>;
    readonly appCrdtInboxService?: ReturnType<RallarCrdtInboxServiceFactory>;
}

export function createRallarMiddleware(
    options: CreateRallarMiddlewareOptions
): RallarMiddlewareRuntime {
    const infrastructure = createRallarMiddlewareInfrastructure(options);
    const inboxServices = createRallarMiddlewareInboxServices(options, infrastructure);
    return assembleRallarMiddlewareRuntime(options, infrastructure, inboxServices);
}

function createRallarMiddlewareInfrastructure(
    options: CreateRallarMiddlewareOptions
): RallarMiddlewareInfrastructure {
    initialiseServerCacheRepositories();
    const qboxEngine = new InboxOutboxEngine();
    const webSocketServer = options.webSocketServer ?? new JsonWebSocketServer();
    const targetResolver = options.targetResolver ??
        createWsServerTargetResolver(webSocketServer, {
            findGroupSnapshotByRef: options.findGroupSnapshotByRef,
            findClientSnapshotByRef: options.findClientSnapshotByRef,
            findGroupSnapshotById: options.findGroupSnapshotById,
            resolveGroupRef: options.resolveGroupRef,
            now: options.now
        });
    const wsQBoxServerService = new WsQueueBoxServerService(
        options.inbox,
        options.outbox ?? options.inbox,
        webSocketServer,
        options.wsRuntimeName ?? 'default-qbox-server',
        {
            targetResolver,
            inboundStores: options.inboundStores,
            outboundStores: options.outboundStores,
            deliveryDiagnostics: options.wsDeliveryDiagnostics,
            // This runtime installs the topic router, which owns room-scoped
            // fanout behind its room authorizer; ALM forwarding of those messages
            // here would bypass that authorization.
            forwardsRoomScopedMessages: false
        }
    );
    const queuePubSubBridgeReadiness = options.queuePubSubBridge
        ? installQueueBoxPubSubBridge({
            ...options.queuePubSubBridge,
            wsQBoxServerService
        })
        : Promise.resolve();
    const inboxQueueReader = new InboxQueueReader(
        options.inbox,
        options.appInboxDequeueOptions
    );
    const outboxQueueReader = new OutboxQueueReader(
        options.outbox ?? options.inbox
    );
    const appInboxResilience = options.resilience.appInbox ?? options.resilience.inbox;
    const appOutboxResilience = options.resilience.appOutbox;
    const wakeQueueEngine = () => qboxEngine.wake();
    return {
        qboxEngine,
        wsQBoxServerService,
        inboxQueueReader,
        outboxQueueReader,
        appInboxResilience,
        appOutboxResilience,
        queuePubSubBridgeReadiness,
        wakeQueueEngine
    };
}

function createRallarMiddlewareInboxServices(
    options: CreateRallarMiddlewareOptions,
    infrastructure: RallarMiddlewareInfrastructure
): RallarMiddlewareInboxServices {
    const {
        inboxQueueReader,
        outboxQueueReader,
        wsQBoxServerService,
        appInboxResilience,
        appOutboxResilience,
        wakeQueueEngine
    } = infrastructure;
    return {
        groupStateInboxService: options.createGroupStateInboxService({
            inboxQueueReader,
            outboxQueueReader,
            wsQBoxServerService,
            appInboxResilience,
            appOutboxResilience,
            wakeQueueEngine
        }),
        topologyInboxService: options.createTopologyInboxService({
            inboxQueueReader,
            appInboxResilience,
            wakeQueueEngine
        }),
        rtcRttInboxService: options.createRtcRttInboxService({
            inboxQueueReader,
            appInboxResilience,
            wakeQueueEngine
        }),
        appClientInboxService: options.createAppClientInboxService({
            inboxQueueReader,
            wsQBoxServerService,
            appInboxResilience,
            wakeQueueEngine
        }),
        appAuthInboxService: options.createAppAuthInboxService?.({
            inboxQueueReader,
            appInboxResilience,
            wakeQueueEngine
        }),
        appAdminInboxService: options.createAppAdminInboxService?.({
            inboxQueueReader,
            outboxQueueReader,
            appInboxResilience,
            wakeQueueEngine
        }),
        appCrdtInboxService: options.createAppCrdtInboxService?.({
            inboxQueueReader,
            outboxQueueReader,
            appInboxResilience,
            wakeQueueEngine
        })
    };
}

function assembleRallarMiddlewareRuntime(
    options: CreateRallarMiddlewareOptions,
    infrastructure: RallarMiddlewareInfrastructure,
    inboxServices: RallarMiddlewareInboxServices
): RallarMiddlewareRuntime {
    const {
        qboxEngine,
        wsQBoxServerService,
        inboxQueueReader,
        outboxQueueReader,
        appInboxResilience,
        appOutboxResilience,
        queuePubSubBridgeReadiness
    } = infrastructure;
    includeWsQueueBoxEngineTasks({
        engine: qboxEngine,
        wsQBoxServerService,
        resilienceInbox: options.resilience.inbox,
        resilienceOutbox: options.resilience.outbox ?? options.resilience.inbox
    });
    includeInboxQueueReaderEngineTasks(
        qboxEngine,
        inboxQueueReader,
        appInboxResilience
    );
    includeOutboxQueueReaderEngineTasks(
        qboxEngine,
        outboxQueueReader,
        appOutboxResilience
    );
    return {
        qboxEngine,
        wsQBoxServerService,
        inboxQueueReader,
        outboxQueueReader,
        appInboxResilience,
        appOutboxResilience,
        ...inboxServices,
        groupStateService: inboxServices.groupStateInboxService.groupStateService,
        clientStateService: inboxServices.appClientInboxService.clientStateService,
        clientsRepository: options.clientsRepository,
        groupsRepository: options.groupsRepository,
        rtcTopologyPublicationRepository: options.rtcTopologyPublicationRepository,
        rtcTopologyExecutionRepository: options.rtcTopologyExecutionRepository,
        rtcTopologyDelivery: options.rtcTopologyDelivery,
        rtcTopologyReplay: options.rtcTopologyReplay,
        readiness: Promise.all([
            options.readiness ?? Promise.resolve(),
            queuePubSubBridgeReadiness
        ]).then(() => undefined),
        healthFailure: options.healthFailure
    };
}
export interface IncludeWsQueueBoxEngineTasksInput {
    readonly engine: InboxOutboxEngine;
    readonly wsQBoxServerService: WsQueueBoxServerService;
    readonly resilienceInbox: ResilienceDto;
    readonly resilienceOutbox: ResilienceDto;
}

export function includeWsQueueBoxEngineTasks(input: IncludeWsQueueBoxEngineTasksInput): void {
    const { engine, wsQBoxServerService, resilienceInbox, resilienceOutbox } = input;
    engine.includeTask(WsQueueBoxServerService.INBOX_ENQUEUE_TYPE, {
        name: WsQueueBoxServerService.INBOX_ENQUEUE_TYPE,
        maxConcurrency: () => 1,
        isWork: () =>
            wsQBoxServerService.inbox.isAnyEntryToLock(
                WsQueueBoxServerService.INBOX_DEQUEUE_TYPES,
                resilienceInbox.toWorkAdvertisementOptions()
            ),
        runnable: () =>
            wsQBoxServerService.dequeueInbox(
                WsQueueBoxServerService.INBOX_DEQUEUE_TYPES,
                resilienceInbox
            ),
        ongoingTasks: []
    });
    engine.includeTask(WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE, {
        name: WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE,
        maxConcurrency: () => 1,
        isWork: () =>
            wsQBoxServerService.outbox.isAnyEntryToLock(
                WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES,
                resilienceOutbox.toWorkAdvertisementOptions()
            ),
        runnable: () =>
            wsQBoxServerService.dequeueOutbox(
                WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES,
                resilienceOutbox
            ),
        ongoingTasks: []
    });
}
export function includeInboxQueueReaderEngineTasks(
    engine: InboxOutboxEngine,
    inboxQueueReader: InboxQueueReader,
    resilience: ResilienceDto
): void {
    engine.includeTask(InboxQueueReader.INBOX_ENQUEUE_TYPE, {
        name: InboxQueueReader.INBOX_ENQUEUE_TYPE,
        maxConcurrency: () => 1,
        isWork: () =>
            inboxQueueReader.inbox.isAnyEntryToLock(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                resilience.toWorkAdvertisementOptions()
            ),
        runnable: () =>
            inboxQueueReader.dequeueInbox(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                resilience
            ),
        ongoingTasks: []
    });
}
export function includeOutboxQueueReaderEngineTasks(
    engine: InboxOutboxEngine,
    outboxQueueReader: OutboxQueueReader,
    resilience: ResilienceDto
): void {
    engine.includeTask(OutboxQueueReader.OUTBOX_ENQUEUE_TYPE, {
        name: OutboxQueueReader.OUTBOX_ENQUEUE_TYPE,
        maxConcurrency: () => 1,
        isWork: () =>
            outboxQueueReader.outbox.isAnyEntryToLock(
                OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
                resilience.toWorkAdvertisementOptions()
            ),
        runnable: () =>
            outboxQueueReader.dequeueOutbox(
                OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
                resilience
            ),
        ongoingTasks: []
    });
}
