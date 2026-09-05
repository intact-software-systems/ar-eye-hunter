import type { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import type { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import type { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import type { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';

import type { AppAdminInboxService } from '../admin-operations/inbox/app-admin-inbox-service.ts';
import type { AppAuthInboxService } from '../auth/inbox/app-auth-inbox-service.ts';
import type { ClientStateService } from '../client-state/client-state-service-contracts.ts';
import type { AppClientInboxService } from '../client-state/inbox/app-client-inbox-service.ts';
import type { ClientStateRepository } from '../client-state/persistence/client-state-repository.ts';
import type { AppCrdtInboxService } from '../crdt/inbox/app-crdt-inbox-service.ts';
import type { GroupStateService } from '../group-state/group-state-service-contracts.ts';
import type { GroupStateInboxService } from '../group-state/inbox/group-state-inbox-service.ts';
import type { GroupStateRepository } from '../group-state/persistence/group-state-repository.ts';
import type { RtcRttInboxService } from '../rtc-rtt/inbox/rtc-rtt-inbox-service.ts';
import type { TopologyInboxService } from '../topology/inbox/topology-inbox-service.ts';
import type { RtcTopologyExecutionRepository } from '../topology/persistence/rtc-topology-execution-repository.ts';
import type { RtcTopologyPublicationRepository } from '../topology/publication/rtc-topology-publication-repository.ts';
import type {
    RtcTopologyReplayMetrics,
    RtcTopologyReplayWakeSource
} from '../topology/replay/consumer/rtc-topology-replay-diagnostics.ts';
import type { RtcTopologyDeliveryRuntime } from '../topology/replay/delivery/rtc-topology-delivery-runtime.ts';

export interface RtcTopologyReplayRuntime {
    wake(source: RtcTopologyReplayWakeSource): void;
    readMetrics(): RtcTopologyReplayMetrics;
    resetMetrics(): void;
}

export interface RallarMiddlewareRuntime {
    readonly qboxEngine: InboxOutboxEngine;
    readonly wsQBoxServerService: WsQueueBoxServerService;
    readonly inboxQueueReader: InboxQueueReader;
    readonly outboxQueueReader: OutboxQueueReader;
    readonly appInboxResilience: ResilienceDto;
    readonly appOutboxResilience: ResilienceDto;
    readonly groupStateInboxService: GroupStateInboxService;
    readonly topologyInboxService: TopologyInboxService;
    readonly rtcRttInboxService: RtcRttInboxService;
    readonly appClientInboxService: AppClientInboxService;
    readonly appAuthInboxService?: AppAuthInboxService;
    readonly appAdminInboxService?: AppAdminInboxService;
    readonly appCrdtInboxService?: AppCrdtInboxService;
    readonly clientStateService: ClientStateService;
    readonly groupStateService: GroupStateService;
    readonly clientsRepository: ClientStateRepository;
    readonly groupsRepository: GroupStateRepository;
    readonly rtcTopologyPublicationRepository?: RtcTopologyPublicationRepository;
    readonly rtcTopologyExecutionRepository?: RtcTopologyExecutionRepository;
    readonly rtcTopologyDelivery?: RtcTopologyDeliveryRuntime;
    readonly rtcTopologyReplay?: RtcTopologyReplayRuntime;
    readonly readiness: Promise<void>;
    readonly healthFailure?: Promise<never>;
}
