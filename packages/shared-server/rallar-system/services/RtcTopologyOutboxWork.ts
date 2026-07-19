import {
    type ALMessage,
    newALRoute,
    newALUntargetedMessage,
} from '@shared/al-contracts/al-contract.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { groupStateGroupStorageKey } from '../group-state-storage-keys.ts';
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
import type { RtcRttRepository } from '../repositories/RtcRttRepository.ts';
import {
    computeTopologyMutation,
    validateTopologyMutation,
} from './rtc-topology-mutations.ts';
import { waitForRuntimeStateWriteRetry } from '../../runtime-state/optimistic-runtime-state-write.ts';
import { recordRallarTiming, type RallarTimingSink } from './timing.ts';
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
    sleep?: (delayMs: number) => Promise<void>;
    timing?: RallarTimingSink;
    serviceId?: string;
}>): OnMessageCallback {
    return {
        onMessage: async (message: ALMessage, _entry: ResourceEntry) => {
            const workEnvelope = readRtcTopologyWorkEnvelope(message);
            const work = workEnvelope.data;
            const workId = toRtcTopologyExecutionId(workEnvelope);
            for (let attempt = 0; attempt < 3; attempt += 1) {
                const backoffMs = await waitForRuntimeStateWriteRetry(
                    attempt as 0 | 1 | 2,
                    { sleep: options.sleep },
                );
                const readStarted = performance.now();
                const [authority, read] = await Promise.all([
                    options.topologyManagement.readTopologyPlanningAuthority(
                        work.groupSnapshot.group,
                    ),
                    options.executionRepository.readTopologyMutation(
                        work.groupSnapshot.group,
                        workId,
                    ),
                ]);
                const group = authority.group;
                if (
                    work.kind === 'group-revision' &&
                    work.sourceGroupStateRevision < readGroupStateRevision(group)
                ) {
                    return;
                }
                const planned = read.publicationClaim && read.snapshot
                    ? {
                        snapshot: read.snapshot.value,
                        previous: read.snapshot.value,
                        changed: false,
                    }
                    : options.topologyManagement
                        .planTopologyFromAuthority(authority, read.snapshot?.value);
                recordTopologyExecutionPhase(
                    options,
                    workId,
                    group.group,
                    'read',
                    readStarted,
                    attempt,
                    backoffMs,
                );
                const computeStarted = performance.now();
                const publication = read.publicationClaim
                    ? null
                    : toTopologyPublication(
                        workEnvelope,
                        group,
                        planned.snapshot,
                    );
                const computed = computeTopologyMutation({
                    read,
                    candidate: planned.snapshot,
                    publication,
                });
                recordTopologyExecutionPhase(
                    options, workId, group.group, 'compute', computeStarted,
                    attempt, backoffMs,
                );
                const validateStarted = performance.now();
                validateTopologyMutation({
                    read,
                    candidate: planned.snapshot,
                    publication,
                    computed,
                });
                recordTopologyExecutionPhase(
                    options, workId, group.group, 'validate', validateStarted,
                    attempt, backoffMs,
                );
                if (computed.outcome === 'superseded') {
                    options.topologyManagement.observeCommittedTopology(
                        group,
                        computed.current,
                    );
                    return;
                }
                if (computed.outcome === 'loaded') {
                    await options.publicationFanout.publish(computed.publication);
                    options.topologyManagement.recordTopologyPublication(true);
                    return;
                }

                const writeStarted = performance.now();
                const transactionStarted = performance.now();
                const written = await options.executionRepository
                    .writeTopologyMutation(computed);
                recordTopologyExecutionPhase(
                    options, workId, group.group, 'transaction', transactionStarted,
                    attempt, backoffMs,
                );
                recordTopologyExecutionPhase(
                    options, workId, group.group, 'write', writeStarted,
                    attempt, backoffMs,
                );
                if (written === 'conflict') {
                    recordRallarTiming(options.timing, {
                        component: 'rtc-topology-execution-service',
                        operation: 'mutation.conflict',
                        serviceId: options.serviceId,
                        requestId: workId,
                        ...canonicalGroupRef(group.group),
                        details: { attempt, backoffMs, conflict: true },
                    }, 'ok', 0);
                    continue;
                }
                options.topologyManagement.observeCommittedTopology(
                    group,
                    computed.snapshotGuard.candidate,
                );
                if (computed.snapshotGuard.candidate.state === 'removed') {
                    options.onInactiveOverlay?.(work.overlayId);
                }
                await options.publicationFanout.publish(publication!);
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

export async function drainRtcRttRecomputeOutbox(input: Readonly<{
    repository: RtcRttRepository;
    publisher: RtcTopologyWorkPublisher;
    debounceMs: number;
}>): Promise<number> {
    let delivered = 0;
    for (const entry of await input.repository.listRecomputeIntentEntries()) {
        await input.publisher.enqueueForRtt(
            entry.value.groupSnapshot,
            entry.value.rtt,
            input.debounceMs,
        );
        const removed = await input.repository.removeRecomputeIntent(
            entry.value.outboxId,
            entry.entry.revision,
        );
        if (removed.status === 'accepted') delivered += 1;
    }
    return delivered;
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
        const winner = await options.outboxQueueReader.enqueueIfAbsent(
            newALUntargetedMessage(
                toAppQueueCreatedBy(options.senderId),
                newALRoute(key.topicId, key.contextId, key.resourceId),
                options.workType,
                envelope,
            ),
        );
        options.wake?.();
        const winnerMessage = JSON.parse(winner.resource) as ALMessage;
        const winnerEnvelope = readRtcTopologyWorkEnvelope(winnerMessage);
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
    group: GroupSnapshot,
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
        groupRef: canonicalGroupRef(group.group),
        sourceGroupStateRevision: snapshot.sourceGroupStateRevision,
        overlayVersion: snapshot.version,
        recipientSessionIds: snapshot.activeSessionIds,
        message: createRtcOverlayTopologyBroadcastMessage(
            group,
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
    overlayId: string,
    stateRevision: number,
    rtt: RttMeasurementInfo,
): string {
    const pair = [rtt.sessionIdFrom, rtt.sessionIdTo].sort().join(':');
    return `${overlayId}:rtt:${stateRevision}:${pair}:${rtt.version}`;
}

function toRtcTopologyQueueContextId(groupRef: GroupRef): string {
    return groupStateGroupStorageKey(groupRef);
}

function canonicalGroupRef(ref: GroupRef): GroupRef {
    return ref.workspaceId === undefined
        ? { applicationId: ref.applicationId, groupId: ref.groupId }
        : {
            applicationId: ref.applicationId,
            workspaceId: ref.workspaceId,
            groupId: ref.groupId,
        };
}

function recordTopologyExecutionPhase(
    options: Readonly<{
        timing?: RallarTimingSink;
        serviceId?: string;
    }>,
    workId: string,
    groupRef: GroupRef,
    phase: 'read' | 'compute' | 'validate' | 'transaction' | 'write',
    started: number,
    attempt: number,
    backoffMs: number,
): void {
    recordRallarTiming(options.timing, {
        component: 'rtc-topology-execution-service',
        operation: `mutation.${phase}`,
        serviceId: options.serviceId,
        requestId: workId,
        ...canonicalGroupRef(groupRef),
        details: { attempt, backoffMs },
    }, 'ok', performance.now() - started);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
    return [...new Set(values)];
}
