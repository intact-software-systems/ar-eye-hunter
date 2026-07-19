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
import type { RtcTopologyPublicationFanout } from '../pubsub/RtcTopologyClusterTransport.ts';
import {
    type RtcTopologyPublication,
    toRtcTopologyPublicationId,
} from '../repositories/RtcTopologyPublicationRepository.ts';
import type { RtcTopologyExecutionRepository } from '../repositories/RtcTopologyExecutionRepository.ts';
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

export type RtcTopologyGroupRevisionWork = Readonly<{
    kind: 'group-revision';
    overlayId: string;
    groupSnapshot: GroupSnapshot;
    sourceGroupStateRevision: number;
    requestedAtEpochMs: number;
}>;

export type RtcTopologyRttRefreshWork = Readonly<{
    kind: 'rtt-refresh';
    overlayId: string;
    groupSnapshot: GroupSnapshot;
    requestedGroupStateRevision: number;
    requestedRttVersion: number;
    requestedAtEpochMs: number;
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
    topologyManagement: GroupTopologyManagementService;
    executionRepository: RtcTopologyExecutionRepository;
    publicationFanout: RtcTopologyPublicationFanout;
    onInactiveOverlay?: (overlayId: string) => void;
}>): OnMessageCallback {
    return {
        onMessage: async (message: ALMessage, _entry: ResourceEntry) => {
            const workEnvelope = readRtcTopologyWorkEnvelope(message);
            const work = workEnvelope.data;
            const group = work.groupSnapshot;
            const workId = toRtcTopologyExecutionId(workEnvelope);
            const existing = await options.executionRepository
                .findPublicationForWork(workId);
            if (existing) {
                await options.publicationFanout.publish(existing);
                options.topologyManagement.recordTopologyPublication(true);
                return;
            }

            let expected = await options.executionRepository.findSnapshot(
                group.group,
            );
            for (let attempt = 0; attempt < 3; attempt += 1) {
                const planned = await options.topologyManagement
                    .planGroupTopology(group, expected);
                const publication = toTopologyPublication(
                    workEnvelope,
                    planned.snapshot,
                );
                const committed = await options.executionRepository.commit({
                    expected,
                    candidate: planned.snapshot,
                    publication,
                });
                if (committed.status === 'retry') {
                    expected = committed.current;
                    if (expected) {
                        options.topologyManagement.observeCommittedTopology(
                            group,
                            expected,
                        );
                    }
                    continue;
                }
                if (committed.status === 'superseded') {
                    options.topologyManagement.observeCommittedTopology(
                        group,
                        committed.current,
                    );
                    return;
                }

                options.topologyManagement.observeCommittedTopology(
                    group,
                    committed.snapshot,
                );
                if (committed.snapshot.state === 'removed') {
                    options.onInactiveOverlay?.(work.overlayId);
                }
                await options.publicationFanout.publish(committed.publication);
                options.topologyManagement.recordTopologyPublication(true);
                return;
            }

            throw new RtcTopologyExecutionConflictError(workId);
        },
    };
}

export class RtcTopologyExecutionConflictError extends Error {
    readonly status = 503;
    readonly code = 'rtc-topology-execution-conflict';

    constructor(readonly workId: string) {
        super(`RTC topology predecessor changed during three execution attempts: ${workId}`);
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
            } satisfies RtcTopologyRttRefreshWork,
            reason: 'rtt',
            requestedAtEpochMs,
            dueAtEpochMs: requestedAtEpochMs + debounceMs,
            merge: mergeRtcTopologyRttWork,
        } as const;
        let result = await options.service.enqueue(input);

        for (
            let successorAttempt = 0;
            result.blockedByReserved;
            successorAttempt += 1
        ) {
            if (successorAttempt >= 10) {
                throw new Error(
                    `RTC topology RTT work exceeded reserved successor limit for ${overlayId}`,
                );
            }
            result = await options.service.enqueue({
                ...input,
                resourceId: toRtcTopologyRttSuccessorResourceId(
                    result.envelope.resourceId,
                    result.envelope.data[COALESCED_APP_OUTBOX_WORK_FIELD]
                        .generation,
                ),
            });
        }
        options.wake?.();
    };

    const publisher: RtcTopologyWorkPublisher = {
        enqueueForGroupSnapshot: async (group) => {
            const overlayId = toScopedOverlayId(group.group);
            const sourceGroupStateRevision = readGroupStateRevision(group);
            const requestedAtEpochMs = now();
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
                    requestedAtEpochMs,
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
    RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork
> {
    return JSON.parse(message.payload.resource) as RtcTopologyWorkEnvelope<
        RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork
    >;
}

function toRtcTopologyExecutionId(
    envelope: RtcTopologyWorkEnvelope<
        RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork
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

function toTopologyPublication(
    envelope: RtcTopologyWorkEnvelope<
        RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork
    >,
    snapshot: Parameters<typeof createRtcOverlayTopologyBroadcastMessage>[1],
): RtcTopologyPublication {
    const workId = toRtcTopologyExecutionId(envelope);
    return {
        publicationId: toRtcTopologyPublicationId({
            workId,
            sourceGroupStateRevision: snapshot.sourceGroupStateRevision,
            overlayVersion: snapshot.version,
        }),
        workId,
        groupRef: envelope.data.groupSnapshot.group,
        sourceGroupStateRevision: snapshot.sourceGroupStateRevision,
        overlayVersion: snapshot.version,
        recipientSessionIds: snapshot.activeSessionIds,
        message: createRtcOverlayTopologyBroadcastMessage(
            envelope.data.groupSnapshot,
            snapshot,
        ),
        createdAtEpochMs: envelope.data.requestedAtEpochMs,
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
    reservedResourceId: string,
    reservedGeneration: number,
): string {
    return `${reservedResourceId}:successor:${reservedGeneration}`;
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
