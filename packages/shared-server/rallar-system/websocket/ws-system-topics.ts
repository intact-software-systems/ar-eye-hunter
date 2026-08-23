import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { initDynamicWsTopicRouter, type DynamicWsTopicRouterOptions } from '../../rallar-facade/ws-topic-router.ts';
import { installChatWsTopic } from '../communication/install-chat-ws-topic.ts';
import { installRtcSignalingWsTopic } from '../communication/install-rtc-signaling-ws-topic.ts';
import type { GroupMutationCommand } from '../group-state/mutation/group-mutation-contracts.ts';
import type { GroupLifecyclePolicyRead } from '../group-state/persistence/group-lifecycle-policy-repository.ts';
import type { RtcRttRuntimeState } from '../rtc-rtt/rtc-rtt-runtime-state.ts';
import { installRtcRttSystemTopic } from '../rtc-rtt/topic/install-rtc-rtt-system-topic.ts';
import type { RtcRttRefinementGate } from '../rtc-rtt/topic/rtc-rtt-refinement-gate.ts';
import type { RtcRttRefinementService } from '../rtc-rtt/topic/rtc-rtt-refinement-service.ts';
import { installStateSyncWsTopics } from '../state-sync/install-state-sync-ws-topics.ts';
import type { GroupTopologyConfigQueryService } from '../topology/config/group-topology-config-query-service.ts';
import type { GroupTopologyGroupSnapshotReader } from '../topology/group-topology-management-contracts.ts';
import type {
    RtcTopologyDeliveryOptions,
    RtcTopologyWorkPublisher
} from '../topology/mutation/rtc-topology-outbox-work.ts';
import type { RtcTopologyExecutionRepository } from '../topology/persistence/rtc-topology-execution-repository.ts';
import type { GroupTopologyPlanningService } from '../topology/planning/group-topology-planning-service.ts';
import { installTopologyWsTopics } from '../topology/publication/install-topology-ws-topics.ts';
import { installTopologyAppOutbox } from '../topology/runtime/install-topology-app-outbox.ts';
import {
    RallarRtcTopologyService,
    type RallarRtcTopologyServiceOptions
} from '../topology/runtime/rallar-rtc-topology-service.ts';

export interface InitRallarSystemWsTopicsOptions {
    readonly initDynamicTopics?: boolean;
    readonly dynamicTopicRouterOptions?: DynamicWsTopicRouterOptions;
    readonly rtcTopologyService?: RallarRtcTopologyService;
    readonly rtcTopologyOptions?: RallarRtcTopologyServiceOptions;
    readonly topologyQuery?: GroupTopologyConfigQueryService;
    readonly topologyPlanning?: GroupTopologyPlanningService;
    readonly rttRefinementGate?: RtcRttRefinementGate;
    readonly rttRefinementService?: RtcRttRefinementService;
    readonly observeGroupSnapshot?: (snapshot: GroupSnapshot) => void | Promise<void>;
    readonly observeClientSnapshot?: (snapshot: ClientSnapshot) => void | Promise<void>;
    readonly rtcRttRuntimeState?: RtcRttRuntimeState;
    readonly globalGraphRecomputeLimit?: Readonly<{
        windowMs: number;
        maxPerWindow: number;
    }>;
    readonly rtcTopologyAppOutbox?: Readonly<{
        database: PSqlSql;
        outboxQueueReader: OutboxQueueReader;
        topicId?: string;
        senderId?: string;
        wake?: () => void;
        wakeReplay?: () => void;
        findGroupSnapshotByRef?: GroupTopologyGroupSnapshotReader;
        executionRepository: RtcTopologyExecutionRepository;
        topologyDelivery?: RtcTopologyDeliveryOptions;
        formationCriterion?: Readonly<{
            readLifecyclePolicy: (ref: GroupRef) => Promise<GroupLifecyclePolicyRead>;
            submitCommand: (command: GroupMutationCommand, atEpochMs: number) => Promise<void>;
        }>;
    }>;
    readonly enqueueRtcRttMutation?: (
        input: Readonly<{
            rtt: RttMeasurementInfo;
            alSenderId: string;
            capturedAtEpochMs: number;
        }>
    ) => Promise<ResourceEntry>;
}

export interface RallarSystemWsTopicsRuntime {
    readonly rtcTopologyWorkPublisher: RtcTopologyWorkPublisher | null;
    stop(): void;
}

export function initRallarSystemWsTopics(
    wsService: WsQueueBoxServerService,
    options: InitRallarSystemWsTopicsOptions = {}
): RallarSystemWsTopicsRuntime {
    const rtcService = options.rtcTopologyService ??
        new RallarRtcTopologyService(options.rtcTopologyOptions);
    const findGroupSnapshotByRef = options.rtcTopologyAppOutbox?.findGroupSnapshotByRef ??
        ((ref: GroupRef) => groupStateSnapshotsRepository.findGroupStateSnapshotByRef(ref));
    const topologyWorkPublisher = installConfiguredTopologyAppOutbox(
        wsService,
        options,
        findGroupSnapshotByRef
    );

    installStateSyncWsTopics(wsService, {
        observeClientSnapshot: options.observeClientSnapshot,
        observeGroupSnapshot: options.observeGroupSnapshot
    });
    installTopologyWsTopics(wsService);
    installChatWsTopic(wsService);
    const rtcRttRuntime = installRtcRttSystemTopic(wsService, {
        service: rtcService,
        serviceOptions: options.rtcTopologyOptions,
        topologyQuery: options.topologyQuery,
        refinementGate: options.rttRefinementGate,
        topologyWorkPublisher: topologyWorkPublisher ?? undefined,
        runtimeState: options.rtcRttRuntimeState,
        findGroupSnapshotByRef,
        globalGraphRecomputeLimit: options.globalGraphRecomputeLimit,
        enqueueMutation: options.enqueueRtcRttMutation
    });
    installRtcSignalingWsTopic(wsService);
    if (options.initDynamicTopics ?? true) {
        initDynamicWsTopicRouter(wsService, options.dynamicTopicRouterOptions);
    }
    return {
        rtcTopologyWorkPublisher: topologyWorkPublisher,
        stop: rtcRttRuntime.stop
    };
}

function installConfiguredTopologyAppOutbox(
    wsService: WsQueueBoxServerService,
    options: InitRallarSystemWsTopicsOptions,
    findGroupSnapshotByRef: GroupTopologyGroupSnapshotReader
): RtcTopologyWorkPublisher | null {
    const appOutbox = options.rtcTopologyAppOutbox;
    if (!appOutbox) {
        return null;
    }
    if (!options.topologyQuery || !options.topologyPlanning) {
        throw new TypeError('RTC topology AppOutbox requires query and planning owners');
    }
    return installTopologyAppOutbox({
        ...appOutbox,
        senderId: appOutbox.senderId ?? wsService.name,
        findGroupSnapshotByRef,
        topologyQuery: options.topologyQuery,
        topologyPlanning: options.topologyPlanning,
        rttRefinementService: options.rttRefinementService,
        nowEpochMs: options.rtcTopologyOptions?.now ?? Date.now
    });
}
