import type { GroupRef } from '@shared/api/group-types.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { AppOutboxType } from '../../app-outbox/app-outbox-type.ts';
import type { GroupMutationCommand } from '../../group-state/mutation/group-mutation-contracts.ts';
import type { GroupLifecyclePolicyRead } from '../../group-state/persistence/group-lifecycle-policy-repository.ts';
import type { RtcRttRefinementService } from '../../rtc-rtt/topic/rtc-rtt-refinement-service.ts';
import type { GroupTopologyConfigQueryService } from '../config/group-topology-config-query-service.ts';
import { createRtcTopologyOutboxPublisher } from '../mutation/rtc-topology-outbox-work.ts';
import type { RtcTopologyExecutionRepository } from '../persistence/rtc-topology-execution-repository.ts';
import type { GroupTopologyGroupSnapshotReader } from '../planning/group-topology-planning-contracts.ts';
import type { GroupTopologyPlanningService } from '../planning/group-topology-planning-service.ts';
import { createFormationTimerWorkHandler } from '../replay/work/create-formation-timer-work-handler.ts';
import {
    createRtcTopologyWorkHandler,
    type RtcTopologyDeliveryOptions
} from '../replay/work/create-rtc-topology-work-handler.ts';
import { createTopologyPromotionWorkHandler } from '../replay/work/create-topology-promotion-work-handler.ts';

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
    /** The route-less promotion consumer (decision 27); absent means no automation. */
    readonly topologyPublication?: Readonly<{
        submitCommand: (command: GroupMutationCommand, atEpochMs: number) => Promise<void>;
    }>;
}

export function installTopologyAppOutbox(
    options: InstallTopologyAppOutboxOptions
): void {
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
                findGroupSnapshotByRef: async (ref, readOptions) =>
                    await options.findGroupSnapshotByRef(ref, readOptions),
                readPlannedTopology: async (ref) => {
                    const view = await options.topologyQuery.readTopologyView(ref);
                    return view.snapshot;
                },
                topologyPlanning: options.topologyPlanning,
                readLifecyclePolicy: options.formationCriterion.readLifecyclePolicy,
                submitCommand: options.formationCriterion.submitCommand,
                nowEpochMs: options.nowEpochMs
            })
        );
    }
    if (options.topologyPublication) {
        options.outboxQueueReader.onOutboxMessageDo(
            AppOutboxType.TOPOLOGY_PROMOTION,
            createTopologyPromotionWorkHandler({
                submitCommand: options.topologyPublication.submitCommand,
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
}
