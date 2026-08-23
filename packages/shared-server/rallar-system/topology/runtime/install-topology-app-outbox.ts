import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import type { PSqlSql } from '../../../postgres/PostgresSqlClient.ts';
import { AppOutboxType } from '../../app-outbox/app-outbox-type.ts';
import type { GroupMutationCommand } from '../../group-state/mutation/group-mutation-contracts.ts';
import type { GroupLifecyclePolicyRead } from '../../group-state/persistence/group-lifecycle-policy-repository.ts';
import type { RtcRttRefinementService } from '../../rtc-rtt/topic/rtc-rtt-refinement-service.ts';
import type { GroupTopologyConfigQueryService } from '../config/group-topology-config-query-service.ts';
import type { GroupTopologyGroupSnapshotReader } from '../group-topology-management-contracts.ts';
import {
    createRtcTopologyOutboxPublisher,
    createRtcTopologyWorkHandler,
    type RtcTopologyDeliveryOptions,
    type RtcTopologyWorkPublisher
} from '../mutation/rtc-topology-outbox-work.ts';
import type { RtcTopologyExecutionRepository } from '../persistence/rtc-topology-execution-repository.ts';
import type { GroupTopologyPlanningService } from '../planning/group-topology-planning-service.ts';
import { createFormationTimerWorkHandler } from '../replay/create-formation-timer-work-handler.ts';

export interface InstallTopologyAppOutboxOptions {
    readonly database: PSqlSql;
    readonly outboxQueueReader: OutboxQueueReader;
    readonly senderId: string;
    readonly topicId?: string;
    readonly wake?: () => void;
    readonly wakeReplay?: () => void;
    readonly findGroupSnapshotByRef: GroupTopologyGroupSnapshotReader;
    readonly executionRepository: RtcTopologyExecutionRepository;
    readonly topologyQuery: GroupTopologyConfigQueryService;
    readonly topologyPlanning: GroupTopologyPlanningService;
    readonly rttRefinementService?: RtcRttRefinementService;
    readonly topologyDelivery?: RtcTopologyDeliveryOptions;
    readonly nowEpochMs: () => number;
    readonly formationCriterion?: Readonly<{
        readLifecyclePolicy: (ref: GroupRef) => Promise<GroupLifecyclePolicyRead>;
        submitCommand: (command: GroupMutationCommand, atEpochMs: number) => Promise<void>;
    }>;
}

export function installTopologyAppOutbox(
    options: InstallTopologyAppOutboxOptions
): RtcTopologyWorkPublisher {
    const runtime = createRtcTopologyOutboxPublisher({
        outboxQueueReader: options.outboxQueueReader,
        senderId: options.senderId,
        topicId: options.topicId,
        wake: options.wake,
        now: options.nowEpochMs
    });
    if (options.formationCriterion) {
        options.outboxQueueReader.onOutboxMessageDo(
            AppOutboxType.FORMATION_TIMER,
            createFormationTimerWorkHandler({
                findGroupSnapshotByRef: async (ref) => await options.findGroupSnapshotByRef(ref),
                readPlannedTopology: async (ref) => {
                    const view = (await options.topologyQuery.readTopologyView(ref)) as Readonly<{
                        snapshot: RallarOverlayTopologySnapshot | null;
                    }>;
                    return view.snapshot;
                },
                topologyPlanning: options.topologyPlanning,
                readLifecyclePolicy: options.formationCriterion.readLifecyclePolicy,
                submitCommand: options.formationCriterion.submitCommand,
                nowEpochMs: options.nowEpochMs
            })
        );
    }
    options.outboxQueueReader.onOutboxMessageDo(
        runtime.workType,
        createRtcTopologyWorkHandler({
            runtime,
            database: options.database,
            topologyPlanning: options.topologyPlanning,
            executionRepository: options.executionRepository,
            rttRefinementService: options.rttRefinementService,
            topologyDelivery: options.topologyDelivery,
            formationCriterion: options.formationCriterion,
            wakeQueue: options.wake,
            wakeReplay: options.wakeReplay
        })
    );
    return runtime.publisher;
}
