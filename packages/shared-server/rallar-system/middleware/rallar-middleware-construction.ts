import type { ALInboundRuntimeStores } from '@shared/alm/ALInboundMessageRuntime.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/ALOutboundMessageRuntime.ts';
import type { DequeueResourceEntryOptions, ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import type { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import type {
    WsDeliveryDiagnosticsSink,
    WsQueueBoxServerService,
    WsServerTargetResolver
} from '@shared/services/WsQueueBoxServerService.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';

import type { AppClientInboxService } from '../client-state/inbox/app-client-inbox-service.ts';
import type { ClientStateRepository } from '../client-state/persistence/client-state-repository.ts';
import type { GroupStateInboxService } from '../group-state/inbox/group-state-inbox-service.ts';
import type { GroupStateRepository } from '../group-state/persistence/group-state-repository.ts';
import type { InstallQueueBoxPubSubBridgeOptions } from '../queue-pubsub/queue-box-pub-sub-bridge.ts';
import type { RtcRttInboxService } from '../rtc-rtt/inbox/rtc-rtt-inbox-service.ts';
import type { TopologyInboxService } from '../topology/inbox/topology-inbox-service.ts';
import type { RtcTopologyExecutionRepository } from '../topology/persistence/rtc-topology-execution-repository.ts';
import type { RtcTopologyPublicationRepository } from '../topology/publication/rtc-topology-publication-repository.ts';
import type { RtcTopologyDeliveryAppendPort } from '../topology/replay/delivery/rtc-topology-delivery-append-port.ts';
import type { WsServerTargetResolutionOptions } from '../websocket/targets/ws-server-target-resolution-options.ts';
import type {
    RallarAdminInboxServiceFactory,
    RallarAuthInboxServiceFactory,
    RallarCrdtInboxServiceFactory
} from './rallar-middleware-inbox-service-factories.ts';
import type { RtcTopologyReplayRuntime } from './rallar-middleware-runtime.ts';

export interface CreateRallarMiddlewareOptions {
    readonly inbox: QueueBoxResourceEntryRepository;
    readonly outbox?: QueueBoxResourceEntryRepository;
    readonly appInboxDequeueOptions?: DequeueResourceEntryOptions;
    readonly webSocketServer?: JsonWebSocketServer;
    readonly wsRuntimeName?: string;
    readonly targetResolver?: WsServerTargetResolver;
    readonly findGroupSnapshotByRef?: WsServerTargetResolutionOptions['findGroupSnapshotByRef'];
    readonly findClientSnapshotByRef?: WsServerTargetResolutionOptions['findClientSnapshotByRef'];
    readonly findGroupSnapshotById?: WsServerTargetResolutionOptions['findGroupSnapshotById'];
    readonly resolveGroupRef?: WsServerTargetResolutionOptions['resolveGroupRef'];
    readonly now?: WsServerTargetResolutionOptions['now'];
    readonly inboundStores?: ALInboundRuntimeStores;
    readonly outboundStores?: ALOutboundRuntimeStores;
    readonly wsDeliveryDiagnostics?: WsDeliveryDiagnosticsSink;
    readonly createGroupStateInboxService: (
        input: Readonly<{
            inboxQueueReader: InboxQueueReader;
            outboxQueueReader: OutboxQueueReader;
            wsQBoxServerService: WsQueueBoxServerService;
            appInboxResilience: ResilienceDto;
            appOutboxResilience: ResilienceDto;
            wakeQueueEngine: () => void;
        }>
    ) => GroupStateInboxService;
    readonly createTopologyInboxService: (
        input: Readonly<{
            inboxQueueReader: InboxQueueReader;
            appInboxResilience: ResilienceDto;
            wakeQueueEngine: () => void;
        }>
    ) => TopologyInboxService;
    readonly createRtcRttInboxService: (
        input: Readonly<{
            inboxQueueReader: InboxQueueReader;
            appInboxResilience: ResilienceDto;
            wakeQueueEngine: () => void;
        }>
    ) => RtcRttInboxService;
    readonly createAppClientInboxService: (
        input: Readonly<{
            inboxQueueReader: InboxQueueReader;
            wsQBoxServerService: WsQueueBoxServerService;
            appInboxResilience: ResilienceDto;
            wakeQueueEngine: () => void;
        }>
    ) => AppClientInboxService;
    readonly createAppAuthInboxService?: RallarAuthInboxServiceFactory;
    readonly createAppAdminInboxService?: RallarAdminInboxServiceFactory;
    readonly createAppCrdtInboxService?: RallarCrdtInboxServiceFactory;
    readonly resilience: Readonly<{
        inbox: ResilienceDto;
        outbox?: ResilienceDto;
        appInbox?: ResilienceDto;
        appOutbox: ResilienceDto;
    }>;
    readonly clientsRepository: ClientStateRepository;
    readonly groupsRepository: GroupStateRepository;
    readonly rtcTopologyPublicationRepository?: RtcTopologyPublicationRepository;
    readonly rtcTopologyExecutionRepository?: RtcTopologyExecutionRepository;
    readonly rtcTopologyDelivery?: Readonly<{
        publisherStreamId: string;
        append: RtcTopologyDeliveryAppendPort;
    }>;
    readonly rtcTopologyReplay?: RtcTopologyReplayRuntime;
    readonly queuePubSubBridge?: Omit<InstallQueueBoxPubSubBridgeOptions, 'wsQBoxServerService'>;
    readonly readiness?: Promise<void>;
    readonly healthFailure?: Promise<never>;
}

export interface RallarMiddlewareInfrastructure {
    readonly wsQBoxServerService: WsQueueBoxServerService;
    readonly inboxQueueReader: InboxQueueReader;
    readonly outboxQueueReader: OutboxQueueReader;
    readonly appInboxResilience: ResilienceDto;
    readonly appOutboxResilience: ResilienceDto;
    readonly queuePubSubBridgeReadiness: Promise<void>;
    readonly wakeQueueEngine: () => void;
}

export interface RallarMiddlewareInboxServices {
    readonly groupStateInboxService: GroupStateInboxService;
    readonly topologyInboxService: TopologyInboxService;
    readonly rtcRttInboxService: RtcRttInboxService;
    readonly appClientInboxService: AppClientInboxService;
    readonly appAuthInboxService?: ReturnType<RallarAuthInboxServiceFactory>;
    readonly appAdminInboxService?: ReturnType<RallarAdminInboxServiceFactory>;
    readonly appCrdtInboxService?: ReturnType<RallarCrdtInboxServiceFactory>;
}
