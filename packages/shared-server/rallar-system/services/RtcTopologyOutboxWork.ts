import {
    type ALMessage,
    newALRoute,
    newALUntargetedMessage,
} from '@shared/al-contracts/al-contract.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import {
    readGroupStateRevision,
} from '@shared/api/group-client-views.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import type { RtcTopologyPublicationFanout } from '../pubsub/RtcTopologyClusterTransport.ts';
import {
    type RtcTopologyPublication,
    type RtcTopologyPublicationRepository,
    toRtcTopologyPublicationId,
} from '../repositories/RtcTopologyPublicationRepository.ts';
import { sendStateSyncMessage } from '../state-sync-routing.ts';
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
    createRtcOverlayTopologyBroadcastMessage,
    type GroupTopologyManagementService,
} from './group-topology-management-service.ts';

export const APP_OUTBOX_RTC_TOPOLOGY_TOPIC = 'app-outbox.rtc-topology';

export type RtcTopologyGroupSnapshotResolver = (
    ref: GroupRef,
    options?: Readonly<{
        minSnapshotVersion?: number;
        minStateRevision?: number;
    }>,
) => GroupSnapshot | undefined | Promise<GroupSnapshot | undefined>;

export type RtcTopologyGroupRevisionWork = Readonly<{
    kind: 'group-revision';
    overlayId: string;
    groupSnapshot: GroupSnapshot;
    sourceGroupStateRevision: number;
}>;

export type RtcTopologyRttRefreshWork = Readonly<{
    kind: 'rtt-refresh';
    overlayId: string;
    groupRef: GroupRef;
    requestedGroupStateRevision: number;
    minRttVersion: number;
}>;

/** @deprecated Persisted APP_OUTBOX rows may still contain this shape. */
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
    outboxQueueReader: OutboxQueueReader;
    publisher: RtcTopologyWorkPublisher;
    workType: string;
    topicId: string;
    senderId: string;
}>;

type RtcTopologyWorkEnvelope<T extends object> = Readonly<{
    type: string;
    topicId: string;
    resourceId: string;
    contextId: string;
    senderId: string;
    data: T;
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
            senderId,
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

export function createRtcTopologyWorkHandler(options: Readonly<{
    runtime: RtcTopologyWorkRuntime;
    findGroupSnapshotByRef: RtcTopologyGroupSnapshotResolver;
    topologyManagement: GroupTopologyManagementService;
    server: JsonWebSocketServer;
    publicationRepository?: RtcTopologyPublicationRepository;
    publicationFanout?: RtcTopologyPublicationFanout;
    now?: () => number;
    onInactiveOverlay?: (overlayId: string) => void;
}>): OnMessageCallback {
    return {
        onMessage: async (message: ALMessage, entry: ResourceEntry) => {
            const workEnvelope = readRtcTopologyWorkEnvelope(message);
            const work = workEnvelope.data;

            if (options.publicationRepository && options.publicationFanout) {
                const existing = await options.publicationRepository
                    .findPublicationForWork(
                        toRtcTopologyExecutionId(workEnvelope),
                    );
                if (existing) {
                    await options.publicationFanout.publish(existing);
                    options.topologyManagement.recordTopologyPublication(true);
                    return;
                }
            }

            const group = await resolveTopologyWorkGroup(
                work,
                options.findGroupSnapshotByRef,
            );

            if (!group) {
                throw new Error(
                    `Group snapshot not found for RTC topology work ${work.overlayId}`,
                );
            }

            if (options.publicationRepository && options.publicationFanout) {
                const workId = toRtcTopologyExecutionId(workEnvelope);
                const reconciliation = await options.topologyManagement
                    .reconcileGroupTopology(group);
                const sourceGroupStateRevision = readWorkStateRevision(
                    work,
                    group,
                );
                const cause = 'kind' in work && work.kind === 'rtt-refresh'
                    ? 'rtt-refresh'
                    : 'group-revision';
                const publication: RtcTopologyPublication = {
                    publicationId: toRtcTopologyPublicationId({
                        overlayId: reconciliation.snapshot.overlayId,
                        cause,
                        sourceGroupStateRevision,
                        overlayVersion: reconciliation.snapshot.version,
                    }),
                    workId,
                    groupRef: group.group,
                    sourceGroupStateRevision,
                    overlayVersion: reconciliation.snapshot.version,
                    recipientSessionIds: reconciliation.snapshot.activeSessionIds,
                    message: createRtcOverlayTopologyBroadcastMessage(
                        group,
                        reconciliation.snapshot,
                    ),
                    createdAtEpochMs: options.now?.() ?? Date.now(),
                };
                const persisted = await options.publicationRepository.putOrLoad(
                    publication,
                );
                if (reconciliation.snapshot.state === 'removed') {
                    options.onInactiveOverlay?.(work.overlayId);
                }
                await options.publicationFanout.publish(persisted.publication);
                options.topologyManagement.recordTopologyPublication(true);
                return;
            }

            if (group.group.status === 'active') {
                await options.topologyManagement.reconfigureGroupTopology({
                    groupRef: group.group,
                    groupSnapshot: group,
                    publisher: (topologyMessage) => {
                        sendStateSyncMessage(options.server, topologyMessage);
                    },
                });
            } else {
                options.onInactiveOverlay?.(work.overlayId);
                await options.topologyManagement.removeGroupTopology(group);
            }

            // Group-revision work is immutable and RTT RESERVED envelopes are
            // never overwritten. There is therefore no post-compute generation
            // check: completing this entry can never acknowledge newer work.
            void entry;
        },
    };
}

function readWorkStateRevision(
    work: RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork | RtcTopologyRecomputeWork,
    group: GroupSnapshot,
): number {
    if ('kind' in work && work.kind === 'group-revision') {
        return work.sourceGroupStateRevision;
    }
    if ('kind' in work && work.kind === 'rtt-refresh') {
        return readGroupStateRevision(group);
    }
    return readGroupStateRevision(group);
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
        const input = {
            type: options.workType,
            topicId: options.topicId,
            resourceId: overlayId,
            contextId: toRtcTopologyQueueContextId(group.group),
            data: {
                kind: 'rtt-refresh',
                overlayId,
                groupRef: group.group,
                requestedGroupStateRevision,
                minRttVersion: rtt.version,
            } satisfies RtcTopologyRttRefreshWork,
            reason: 'rtt',
            dueAtEpochMs: now() + debounceMs,
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

    const publisher: RtcTopologyWorkPublisher = {
        enqueueForGroupSnapshot: async (group) => {
            const overlayId = toScopedOverlayId(group.group);
            const sourceGroupStateRevision = readGroupStateRevision(group);
            const envelope: RtcTopologyWorkEnvelope<RtcTopologyGroupRevisionWork> = {
                type: options.workType,
                topicId: options.topicId,
                resourceId: toRtcTopologyGroupRevisionResourceId(
                    overlayId,
                    sourceGroupStateRevision,
                ),
                contextId: toRtcTopologyQueueContextId(group.group),
                senderId: options.senderId,
                data: {
                    kind: 'group-revision',
                    overlayId,
                    groupSnapshot: group,
                    sourceGroupStateRevision,
                },
            };
            const key = toAppQueueKey(envelope);
            await options.outboxQueueReader.enqueueIfAbsent(
                newALUntargetedMessage(
                    toAppQueueCreatedBy(options.senderId),
                    newALRoute(key.topicId, key.contextId, key.resourceId),
                    options.workType,
                    envelope,
                ),
            );
            options.wake?.();
        },
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

function readRtcTopologyWorkEnvelope(
    message: ALMessage,
): RtcTopologyWorkEnvelope<
    RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork | RtcTopologyRecomputeWork
> {
    return JSON.parse(message.payload.resource) as RtcTopologyWorkEnvelope<
        RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork | RtcTopologyRecomputeWork
    >;
}

function toRtcTopologyExecutionId(
    envelope: RtcTopologyWorkEnvelope<
        RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork | RtcTopologyRecomputeWork
    >,
): string {
    const metadata = (envelope.data as Record<string, unknown>)[
        COALESCED_APP_OUTBOX_WORK_FIELD
    ] as { generation?: number } | undefined;
    return [
        envelope.topicId,
        envelope.contextId,
        envelope.resourceId,
        metadata?.generation ?? 0,
    ].join(':');
}

async function resolveTopologyWorkGroup(
    work: RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork | RtcTopologyRecomputeWork,
    findGroupSnapshotByRef: RtcTopologyGroupSnapshotResolver,
): Promise<GroupSnapshot | undefined> {
    if ('kind' in work && work.kind === 'group-revision') {
        return work.groupSnapshot;
    }
    if ('kind' in work && work.kind === 'rtt-refresh') {
        return await findGroupSnapshotByRef(work.groupRef, {
            minStateRevision: work.requestedGroupStateRevision,
        });
    }
    return await findGroupSnapshotByRef(work.groupRef, {
        minSnapshotVersion: work.minGroupSnapshotVersion,
    });
}

function mergeRtcTopologyRttWork(
    existing: CoalescedAppOutboxWorkData<RtcTopologyRttRefreshWork>,
    incoming: CoalescedAppOutboxWorkData<RtcTopologyRttRefreshWork>,
): CoalescedAppOutboxWorkData<RtcTopologyRttRefreshWork> {
    const previous = existing[COALESCED_APP_OUTBOX_WORK_FIELD];
    const next = incoming[COALESCED_APP_OUTBOX_WORK_FIELD];
    return {
        ...incoming,
        requestedGroupStateRevision: Math.max(
            existing.requestedGroupStateRevision,
            incoming.requestedGroupStateRevision,
        ),
        minRttVersion: Math.max(existing.minRttVersion, incoming.minRttVersion),
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
    const pair = [rtt.sessionIdFrom, rtt.sessionIdTo].sort().join(':');
    return `${overlayId}:rtt:${stateRevision}:${pair}:${rtt.version}`;
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
