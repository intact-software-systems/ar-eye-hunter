import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { sendStateSyncMessage } from '../state-sync-routing.ts';
import { AppOutboxType } from './AppOutboxService.ts';
import {
    COALESCED_APP_OUTBOX_WORK_FIELD,
    type CoalescedAppOutboxWorkData,
    CoalescedAppOutboxWorkService,
} from './CoalescedAppOutboxWorkService.ts';
import type { GroupTopologyManagementService } from './group-topology-management-service.ts';

export const APP_OUTBOX_RTC_TOPOLOGY_TOPIC = 'app-outbox.rtc-topology';

export type RtcTopologyGroupSnapshotResolver = (
    ref: GroupRef,
    options?: Readonly<{ minSnapshotVersion?: number }>,
) => GroupSnapshot | undefined | Promise<GroupSnapshot | undefined>;

export type RtcTopologyRecomputeWork = Readonly<{
    overlayId: string;
    groupRef: GroupRef;
    minGroupSnapshotVersion: number;
    minRttVersion?: number;
}>;

export type RtcTopologyWorkPublisher = Readonly<{
    enqueueForGroupSnapshot(group: GroupSnapshot): Promise<void>;
    enqueueForRtt(
        group: GroupSnapshot,
        rtt: RttMeasurementInfo,
        debounceMs: number,
    ): Promise<void>;
    enqueueForRttGroups(
        rtt: RttMeasurementInfo,
        groups: readonly GroupSnapshot[],
        debounceMs: number,
    ): Promise<void>;
}>;

export type RtcTopologyWorkRuntime = Readonly<{
    service: CoalescedAppOutboxWorkService;
    publisher: RtcTopologyWorkPublisher;
    workType: string;
    topicId: string;
}>;

type CreateRtcTopologyWorkRuntimeOptions = Readonly<{
    service: CoalescedAppOutboxWorkService;
    workType: string;
    topicId: string;
    wake?: () => void;
    now?: () => number;
}>;

export function createRtcTopologyOutboxPublisher(options: Readonly<{
    outboxQueueReader: OutboxQueueReader;
    senderId?: string;
    topicId?: string;
    wake?: () => void;
    now?: () => number;
}>): RtcTopologyWorkRuntime {
    return createRtcTopologyWorkRuntime({
        service: new CoalescedAppOutboxWorkService(
            options.outboxQueueReader,
            options.senderId,
            options.now,
        ),
        workType: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
        topicId: options.topicId ?? APP_OUTBOX_RTC_TOPOLOGY_TOPIC,
        wake: options.wake,
        now: options.now,
    });
}

export function createRtcTopologyWorkHandler(options: Readonly<{
    runtime: RtcTopologyWorkRuntime;
    findGroupSnapshotByRef: RtcTopologyGroupSnapshotResolver;
    topologyManagement: GroupTopologyManagementService;
    server: JsonWebSocketServer;
    onInactiveOverlay?: (overlayId: string) => void;
}>): OnMessageCallback {
    return {
        onMessage: async (_message: ALMessage, entry: ResourceEntry) => {
            const work = options.runtime.service
                .readEnvelope<RtcTopologyRecomputeWork>(entry);
            const group = await options.findGroupSnapshotByRef(
                work.data.groupRef,
                {
                    minSnapshotVersion: work.data.minGroupSnapshotVersion,
                },
            );

            if (!group) {
                throw new Error(
                    `Group snapshot not found for RTC topology work ${work.data.overlayId}`,
                );
            }

            if (group.group.status === 'active') {
                await options.topologyManagement.reconfigureGroupTopology({
                    groupRef: group.group,
                    groupSnapshot: group,
                    publisher: (message) => {
                        sendStateSyncMessage(options.server, message);
                    },
                });
            } else {
                options.onInactiveOverlay?.(work.data.overlayId);
                await options.topologyManagement.removeGroupTopology(group);
            }

            if (await options.runtime.service.isReservedEntryStale(entry)) {
                throw new Error(
                    `Coalesced RTC topology work advanced while processing ${work.data.overlayId}`,
                );
            }
        },
    };
}

function createRtcTopologyWorkRuntime(
    options: CreateRtcTopologyWorkRuntimeOptions,
): RtcTopologyWorkRuntime {
    const now = options.now ?? (() => Date.now());
    const enqueue = async (
        group: GroupSnapshot,
        input: Readonly<{
            reason: 'group-snapshot' | 'rtt';
            minRttVersion?: number;
            dueAtEpochMs: number;
        }>,
    ): Promise<void> => {
        const overlayId = toScopedOverlayId(group.group);
        await options.service.enqueue<RtcTopologyRecomputeWork>({
            type: options.workType,
            topicId: options.topicId,
            resourceId: overlayId,
            contextId: toRtcTopologyQueueContextId(group.group),
            data: {
                overlayId,
                groupRef: group.group,
                minGroupSnapshotVersion: group.group.snapshotVersion,
                minRttVersion: input.minRttVersion,
            },
            reason: input.reason,
            dueAtEpochMs: input.dueAtEpochMs,
            merge: mergeRtcTopologyWork,
        });
        options.wake?.();
    };

    const publisher: RtcTopologyWorkPublisher = {
        enqueueForGroupSnapshot: async (group) => {
            await enqueue(group, {
                reason: 'group-snapshot',
                dueAtEpochMs: now(),
            });
        },
        enqueueForRtt: async (group, rtt, debounceMs) => {
            await enqueue(group, {
                reason: 'rtt',
                minRttVersion: rtt.version,
                dueAtEpochMs: now() + debounceMs,
            });
        },
        enqueueForRttGroups: async (rtt, groups, debounceMs) => {
            for (const group of groups) {
                await publisher.enqueueForRtt(group, rtt, debounceMs);
            }
        },
    };

    return {
        service: options.service,
        publisher,
        workType: options.workType,
        topicId: options.topicId,
    };
}

function mergeRtcTopologyWork(
    existing: CoalescedAppOutboxWorkData<RtcTopologyRecomputeWork>,
    incoming: CoalescedAppOutboxWorkData<RtcTopologyRecomputeWork>,
): CoalescedAppOutboxWorkData<RtcTopologyRecomputeWork> {
    const previous = existing[COALESCED_APP_OUTBOX_WORK_FIELD];
    const next = incoming[COALESCED_APP_OUTBOX_WORK_FIELD];
    const reasons = uniqueStrings([...previous.reasons, ...next.reasons]);
    const dueAtEpochMs = reasons.includes('group-snapshot')
        ? Math.min(previous.dueAtEpochMs, next.dueAtEpochMs)
        : Math.max(previous.dueAtEpochMs, next.dueAtEpochMs);

    return {
        ...incoming,
        minGroupSnapshotVersion: Math.max(
            existing.minGroupSnapshotVersion,
            incoming.minGroupSnapshotVersion,
        ),
        minRttVersion: Math.max(
            existing.minRttVersion ?? 0,
            incoming.minRttVersion ?? 0,
        ),
        [COALESCED_APP_OUTBOX_WORK_FIELD]: {
            ...next,
            dueAtEpochMs,
            reasons,
        },
    };
}

function toRtcTopologyQueueContextId(groupRef: GroupRef): string {
    return [
        groupRef.applicationId,
        groupRef.workspaceId ?? '',
        groupRef.groupId,
    ].join(':');
}

function uniqueStrings(values: readonly string[]): readonly string[] {
    return [...new Set(values)];
}
