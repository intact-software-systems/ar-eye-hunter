import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { toRateLimiter } from '@shared/resilience/Resilience.ts';
import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import type { GroupTopologyConfigQueryService } from '../../topology/config/group-topology-config-query-service.ts';
import type { GroupTopologyGroupSnapshotReader } from '../../topology/group-topology-management-contracts.ts';
import type { RtcTopologyWorkPublisher } from '../../topology/mutation/rtc-topology-outbox-work.ts';
import {
    RallarRtcTopologyService,
    type RallarRtcTopologyServiceOptions
} from '../../topology/runtime/rallar-rtc-topology-service.ts';
import type { RtcRttRuntimeState } from '../rtc-rtt-runtime-state.ts';
import { computeGlobalGraphAndCacheItIfPossible, initRtcRttTopic } from './init-rtc-rtt-topic.ts';
import type { RtcRttRefinementGate } from './rtc-rtt-refinement-gate.ts';

const DEFAULT_GLOBAL_GRAPH_RECOMPUTE_LIMIT = {
    windowMs: 5_000,
    maxPerWindow: 2
} as const;

export interface InstallRtcRttSystemTopicOptions {
    readonly service?: RallarRtcTopologyService;
    readonly serviceOptions?: RallarRtcTopologyServiceOptions;
    readonly topologyQuery?: GroupTopologyConfigQueryService;
    readonly refinementGate?: RtcRttRefinementGate;
    readonly topologyWorkPublisher?: RtcTopologyWorkPublisher;
    readonly runtimeState?: RtcRttRuntimeState;
    readonly findGroupSnapshotByRef: GroupTopologyGroupSnapshotReader;
    readonly globalGraphRecomputeLimit?: Readonly<{
        windowMs: number;
        maxPerWindow: number;
    }>;
    readonly enqueueMutation?: (
        input: Readonly<{
            rtt: RttMeasurementInfo;
            alSenderId: string;
            capturedAtEpochMs: number;
        }>
    ) => Promise<ResourceEntry>;
}

export interface RtcRttSystemTopicRuntime {
    readonly service: RallarRtcTopologyService;
    stop(): void;
}

export function installRtcRttSystemTopic(
    wsService: WsQueueBoxServerService,
    options: InstallRtcRttSystemTopicOptions
): RtcRttSystemTopicRuntime {
    const service = options.service ?? new RallarRtcTopologyService(options.serviceOptions);
    const limit = options.globalGraphRecomputeLimit ?? DEFAULT_GLOBAL_GRAPH_RECOMPUTE_LIMIT;
    const limiter = toRateLimiter(limit.windowMs, limit.maxPerWindow);
    let recomputeTimer: ReturnType<typeof setTimeout> | undefined;

    const armRecompute = (delayMs: number): void => {
        if (recomputeTimer) {
            return;
        }
        recomputeTimer = setTimeout(() => {
            recomputeTimer = undefined;
            runRecompute();
        }, delayMs);
        (recomputeTimer as { unref?: () => void; }).unref?.();
    };
    const runRecompute = (): void => {
        if (!limiter.allow()) {
            armRecompute(limit.windowMs);
            return;
        }
        computeGlobalGraphAndCacheItIfPossible(service.readRttReportingDegreeLimit());
    };
    const scheduleRecompute = (): void => {
        const delayMs = service.readRttRebuildDebounceMs();
        delayMs === 0 ? runRecompute() : armRecompute(delayMs);
    };

    initRtcRttTopic({
        wsQueueBoxServerService: wsService,
        rtcTopologyService: service,
        rtcTopologyWorkPublisher: options.topologyWorkPublisher,
        runtimeState: options.runtimeState,
        rttRefinementGate: options.refinementGate,
        scheduleGlobalGraphRttRecompute: scheduleRecompute,
        findGroupSnapshotByRef: options.findGroupSnapshotByRef,
        enqueueRtcRttMutation: options.enqueueMutation,
        readGroupRttReportingDegreeLimit: options.topologyQuery
            ? async (group: GroupSnapshot) => {
                const config = await options.topologyQuery!.readConfig(group.group);
                return service.readRttReportingDegreeLimit({
                    ...config.effective,
                    rttReportingDegreeLimit: options.serviceOptions?.rttReportingDegreeLimit
                });
            }
            : undefined
    });
    return {
        service,
        stop: () => {
            if (recomputeTimer) {
                clearTimeout(recomputeTimer);
                recomputeTimer = undefined;
            }
        }
    };
}
