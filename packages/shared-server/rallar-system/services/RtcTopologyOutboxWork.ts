import {
    newALRoute,
    newALUntargetedMessage,
} from '@shared/al-contracts/al-contract.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { CanonicalGroupTopologyConfigPatch } from '@shared/api/graph-topology-management-types.ts';
import {
    toCanonicalGroupTopologyConfigPatch,
} from '@shared/api/group-topology-config-canonical.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import {
    readGroupStateRevision,
} from '@shared/api/group-client-views.ts';
import type {
    GroupSnapshot,
} from '@shared/api/group-types.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import {
    toCanonicalRtcTopologyPairIdentity,
} from '../rtc-topology-identifiers.ts';
import { AppOutboxType } from './AppOutboxService.ts';
import {
    COALESCED_APP_OUTBOX_WORK_FIELD,
    type CoalescedAppOutboxWorkData,
    CoalescedAppOutboxWorkService,
} from './CoalescedAppOutboxWorkService.ts';
import {
    toAppQueueCreatedBy,
    toAppQueueKey,
} from './app-inbox-queue-key.ts';
import {
    parsePersistedRtcTopologyALMessage,
    readRtcTopologyWorkEnvelope,
    toRtcTopologyQueueContextId,
    type RtcTopologyWorkEnvelope,
} from '../topology/replay/rtc-topology-work-codec.ts';
export {
    createRtcTopologyWorkHandler,
    type RtcTopologyDeliveryOptions,
} from '../topology/replay/create-rtc-topology-work-handler.ts';
export {
    APP_OUTBOX_RTC_TOPOLOGY_TOPIC,
    computeRtcTopologyEntry,
    type ComputedRtcTopologyOutbox,
    writeRtcTopologyOutbox,
} from './rtc-topology-outbox-entry.ts';
import { APP_OUTBOX_RTC_TOPOLOGY_TOPIC } from './rtc-topology-outbox-entry.ts';

export type RtcTopologyGroupRevisionWork = Readonly<{
    kind: 'group-revision';
    overlayId: string;
    groupSnapshot: GroupSnapshot;
    sourceGroupStateRevision: number;
    requestedAtEpochMs: number;
    requestOptions: CanonicalGroupTopologyConfigPatch;
    publish: boolean;
}>;

export type RtcTopologyRttRefreshWork = Readonly<{
    kind: 'rtt-refresh';
    overlayId: string;
    groupSnapshot: GroupSnapshot;
    requestedGroupStateRevision: number;
    requestedRttVersion: number;
    requestedAtEpochMs: number;
    requestOptions: CanonicalGroupTopologyConfigPatch;
    publish: boolean;
}>;

export type RtcTopologyStateMutationPublisher = Readonly<{
    enqueueForStateMutation(
        group: GroupSnapshot,
        deliveryId: string,
    ): Promise<RtcTopologyGroupEnqueueResult>;
}>;

export type RtcTopologyWorkPublisher =
    & RtcTopologyStateMutationPublisher
    & Readonly<{
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

export type RtcTopologyGroupEnqueueResult = Readonly<{
    effectiveSnapshotRevision: number;
}>;

export type RtcTopologyWorkRuntime = Readonly<{
    service: CoalescedAppOutboxWorkService;
    outboxQueueReader: OutboxQueueReader;
    publisher: RtcTopologyWorkPublisher;
    workType: string;
    topicId: string;
    senderId: string;
}>;

type CreateRtcTopologyWorkRuntimeOptions = Readonly<{
    service: CoalescedAppOutboxWorkService;
    outboxQueueReader: OutboxQueueReader;
    senderId: string;
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
    const senderId = options.senderId ?? 'rallar-server';
    return createRtcTopologyWorkRuntime({
        service: new CoalescedAppOutboxWorkService(
            options.outboxQueueReader,
            toAppQueueCreatedBy(senderId),
            options.now,
        ),
        outboxQueueReader: options.outboxQueueReader,
        senderId,
        workType: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
        topicId: options.topicId ?? APP_OUTBOX_RTC_TOPOLOGY_TOPIC,
        wake: options.wake,
        now: options.now,
    });
}

export class RtcTopologyExecutionConflictError extends Error {
    readonly status = 503;
    readonly code = 'rtc-topology-execution-conflict';

    readonly workId: string;

    constructor(workId: string) {
        super(`RTC topology predecessor changed before the queued attempt committed: ${workId}`);
        this.workId = workId;
        this.name = 'RtcTopologyExecutionConflictError';
    }
}

function createRtcTopologyWorkRuntime(
    options: CreateRtcTopologyWorkRuntimeOptions,
): RtcTopologyWorkRuntime {
    const now = options.now ?? (() => Date.now());

    const enqueueRtt = async (
        group: GroupSnapshot,
        rtt: RttMeasurementInfo,
        debounceMs: number,
    ): Promise<void> => {
        const overlayId = toScopedOverlayId(group.group);
        const requestedGroupStateRevision = readGroupStateRevision(group);
        const requestedAtEpochMs = now();
        const input = {
            type: options.workType,
            topicId: options.topicId,
            resourceId: overlayId,
            contextId: toRtcTopologyQueueContextId(group.group),
            data: {
                kind: 'rtt-refresh',
                overlayId,
                groupSnapshot: group,
                requestedGroupStateRevision,
                requestedRttVersion: rtt.version,
                requestedAtEpochMs,
                requestOptions: toCanonicalGroupTopologyConfigPatch({}),
                publish: true,
            } satisfies RtcTopologyRttRefreshWork,
            reason: 'rtt',
            requestedAtEpochMs,
            dueAtEpochMs: requestedAtEpochMs + debounceMs,
            merge: mergeRtcTopologyRttWork,
        } as const;
        const result = await options.service.enqueue(input);

        if (result.blockedByReserved) {
            await options.service.enqueue({
                ...input,
                resourceId: toRtcTopologyRttSuccessorResourceId(
                    overlayId,
                    requestedGroupStateRevision,
                    rtt,
                ),
            });
        }
        options.wake?.();
    };

    const enqueueGroupSnapshot = async (
        group: GroupSnapshot,
        deliveryId?: string,
    ): Promise<RtcTopologyGroupEnqueueResult> => {
        const overlayId = toScopedOverlayId(group.group);
        const sourceGroupStateRevision = readGroupStateRevision(group);
        const requestedAtEpochMs = now();
        const envelope: RtcTopologyWorkEnvelope<RtcTopologyGroupRevisionWork> = {
            type: options.workType,
            topicId: options.topicId,
            resourceId: deliveryId ??
                toRtcTopologyGroupRevisionResourceId(
                    overlayId,
                    sourceGroupStateRevision,
                ),
            contextId: toRtcTopologyQueueContextId(group.group),
            senderId: toAppQueueCreatedBy(options.senderId),
            data: {
                kind: 'group-revision',
                overlayId,
                groupSnapshot: group,
                sourceGroupStateRevision,
                requestedAtEpochMs,
                requestOptions: toCanonicalGroupTopologyConfigPatch({}),
                publish: true,
            },
        };
        const key = toAppQueueKey(envelope);
        const winner = await options.outboxQueueReader.enqueueIfAbsent(
            newALUntargetedMessage(
                toAppQueueCreatedBy(options.senderId),
                newALRoute(key.topicId, key.contextId, key.resourceId),
                options.workType,
                envelope,
            ),
        );
        options.wake?.();
        const winnerMessage = parsePersistedRtcTopologyALMessage(winner.resource);
        const winnerEnvelope = readRtcTopologyWorkEnvelope(
            winnerMessage,
            options.workType,
        );
        if (winnerEnvelope.data.kind !== 'group-revision') {
            throw new TypeError(
                'RTC topology group enqueue resolved non-group work',
            );
        }
        return {
            effectiveSnapshotRevision:
                winnerEnvelope.data.sourceGroupStateRevision,
        };
    };

    const publisher: RtcTopologyWorkPublisher = {
        enqueueForGroupSnapshot: async (group) => {
            await enqueueGroupSnapshot(group);
        },
        enqueueForStateMutation: enqueueGroupSnapshot,
        enqueueForRtt: enqueueRtt,
        enqueueForRttGroups: async (rtt, groups, debounceMs) => {
            for (const group of groups) {
                await enqueueRtt(group, rtt, debounceMs);
            }
        },
    };

    return {
        service: options.service,
        outboxQueueReader: options.outboxQueueReader,
        publisher,
        workType: options.workType,
        topicId: options.topicId,
        senderId: options.senderId,
    };
}

function mergeRtcTopologyRttWork(
    existing: CoalescedAppOutboxWorkData<RtcTopologyRttRefreshWork>,
    incoming: CoalescedAppOutboxWorkData<RtcTopologyRttRefreshWork>,
): CoalescedAppOutboxWorkData<RtcTopologyRttRefreshWork> {
    const previous = existing[COALESCED_APP_OUTBOX_WORK_FIELD];
    const next = incoming[COALESCED_APP_OUTBOX_WORK_FIELD];
    const selectedGroup = existing.requestedGroupStateRevision >
            incoming.requestedGroupStateRevision
        ? existing
        : incoming;
    return {
        ...incoming,
        groupSnapshot: selectedGroup.groupSnapshot,
        requestedGroupStateRevision: Math.max(
            existing.requestedGroupStateRevision,
            incoming.requestedGroupStateRevision,
        ),
        requestedRttVersion: Math.max(
            existing.requestedRttVersion,
            incoming.requestedRttVersion,
        ),
        requestedAtEpochMs: Math.max(
            existing.requestedAtEpochMs,
            incoming.requestedAtEpochMs,
        ),
        [COALESCED_APP_OUTBOX_WORK_FIELD]: {
            ...next,
            dueAtEpochMs: Math.max(previous.dueAtEpochMs, next.dueAtEpochMs),
            reasons: uniqueStrings([...previous.reasons, ...next.reasons]),
        },
    };
}

function toRtcTopologyGroupRevisionResourceId(
    overlayId: string,
    stateRevision: number,
): string {
    return `${overlayId}:group-revision:${stateRevision}`;
}

function toRtcTopologyRttSuccessorResourceId(
    overlayId: string,
    stateRevision: number,
    rtt: RttMeasurementInfo,
): string {
    const pair = toCanonicalRtcTopologyPairIdentity(
        rtt.sessionIdFrom,
        rtt.sessionIdTo,
    );
    return `${overlayId}:rtt:${stateRevision}:pair=${encodeURIComponent(pair)}:${rtt.version}`;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
    return [...new Set(values)];
}
