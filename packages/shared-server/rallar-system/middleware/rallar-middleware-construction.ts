import type { ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { DequeueResourceEntryOptions, ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import type { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import type { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import type {
    WsDeliveryDiagnosticsSink,
    WsServerTargetResolver
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import type { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import type { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import type { AppAdminInboxService } from '../admin-operations/inbox/app-admin-inbox-service.ts';
import type { AppAuthInboxService } from '../auth/inbox/app-auth-inbox-service.ts';
import type { AppClientInboxService } from '../client-state/inbox/app-client-inbox-service.ts';
import type { ClientStateRepository } from '../client-state/persistence/client-state-repository.ts';
import type { AppCrdtInboxService } from '../crdt/inbox/app-crdt-inbox-service.ts';
import type { GroupStateInboxService } from '../group-state/inbox/group-state-inbox-service.ts';
import type { GroupStateRepository } from '../group-state/persistence/group-state-repository.ts';
import type { InstallQueueBoxPubSubBridgeOptions } from '../queue-pubsub/queue-box-pub-sub-bridge.ts';
import type { RtcRttInboxService } from '../rtc-rtt/inbox/rtc-rtt-inbox-service.ts';
import type { TopologyInboxService } from '../topology/inbox/topology-inbox-service.ts';
import type { RtcTopologyExecutionRepository } from '../topology/persistence/rtc-topology-execution-repository.ts';
import type { RtcTopologyPublicationRepository } from '../topology/publication/rtc-topology-publication-repository.ts';
import type { RtcTopologyDeliveryRuntime } from '../topology/replay/delivery/rtc-topology-delivery-runtime.ts';
import type { WsServerTargetResolutionOptions } from '../websocket/targets/ws-server-target-resolution-options.ts';
import type {
    RallarAdminInboxServiceFactory,
    RallarAuthInboxServiceFactory,
    RallarCrdtInboxServiceFactory
} from './rallar-middleware-inbox-service-factories.ts';
import type { RtcTopologyReplayRuntime } from './rallar-middleware-runtime.ts';

export interface RallarGroupStateInboxServiceFactoryInput {
    readonly inboxQueueReader: InboxQueueReader;
    readonly outboxQueueReader: OutboxQueueReader;
    readonly wsQBoxServerService: WsQueueBoxServerService;
    readonly appInboxResilience: ResilienceDto;
    readonly appOutboxResilience: ResilienceDto;
    readonly wakeQueueEngine: () => void;
}

export interface RallarTopologyInboxServiceFactoryInput {
    readonly inboxQueueReader: InboxQueueReader;
    readonly appInboxResilience: ResilienceDto;
    readonly wakeQueueEngine: () => void;
}

export interface RallarRtcRttInboxServiceFactoryInput {
    readonly inboxQueueReader: InboxQueueReader;
    readonly appInboxResilience: ResilienceDto;
    readonly wakeQueueEngine: () => void;
}

export interface RallarAppClientInboxServiceFactoryInput {
    readonly inboxQueueReader: InboxQueueReader;
    readonly wsQBoxServerService: WsQueueBoxServerService;
    readonly appInboxResilience: ResilienceDto;
    readonly wakeQueueEngine: () => void;
}

export interface RallarMiddlewareResilience {
    readonly inbox: ResilienceDto;
    readonly outbox?: ResilienceDto;
    readonly appInbox?: ResilienceDto;
    readonly appOutbox: ResilienceDto;
}

export interface CreateRallarMiddlewareOptions {
    readonly inbox: QueueBoxResourceEntryRepository;
    readonly outbox?: QueueBoxResourceEntryRepository;
    readonly appInboxDequeueOptions?: DequeueResourceEntryOptions;
    readonly webSocketServer?: JsonWebSocketServer;
    readonly wsRuntimeName?: string;
    readonly targetResolver?: WsServerTargetResolver;
    readonly findGroupSnapshotByRef?: WsServerTargetResolutionOptions['findGroupSnapshotByRef'];
    readonly findClientSnapshotByRef?: WsServerTargetResolutionOptions['findClientSnapshotByRef'];
    readonly now?: WsServerTargetResolutionOptions['now'];
    readonly inboundStores?: ALInboundRuntimeStores;
    readonly outboundStores?: ALOutboundRuntimeStores;
    readonly wsDeliveryDiagnostics?: WsDeliveryDiagnosticsSink;
    readonly createGroupStateInboxService: (
        input: RallarGroupStateInboxServiceFactoryInput
    ) => GroupStateInboxService;
    readonly createTopologyInboxService: (
        input: RallarTopologyInboxServiceFactoryInput
    ) => TopologyInboxService;
    readonly createRtcRttInboxService: (
        input: RallarRtcRttInboxServiceFactoryInput
    ) => RtcRttInboxService;
    readonly createAppClientInboxService: (
        input: RallarAppClientInboxServiceFactoryInput
    ) => AppClientInboxService;
    readonly createAppAuthInboxService?: RallarAuthInboxServiceFactory;
    readonly createAppAdminInboxService?: RallarAdminInboxServiceFactory;
    readonly createAppCrdtInboxService?: RallarCrdtInboxServiceFactory;
    readonly resilience: RallarMiddlewareResilience;
    readonly clientsRepository: ClientStateRepository;
    readonly groupsRepository: GroupStateRepository;
    readonly rtcTopologyPublicationRepository?: RtcTopologyPublicationRepository;
    readonly rtcTopologyExecutionRepository?: RtcTopologyExecutionRepository;
    readonly rtcTopologyDelivery?: RtcTopologyDeliveryRuntime;
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
    readonly appAuthInboxService?: AppAuthInboxService;
    readonly appAdminInboxService?: AppAdminInboxService;
    readonly appCrdtInboxService?: AppCrdtInboxService;
}
