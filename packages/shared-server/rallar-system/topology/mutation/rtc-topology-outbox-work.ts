import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { CanonicalGroupTopologyConfigPatch } from '@shared/api/graph-topology-management-types.ts';
import { compareGroupCausalRevision, readGroupCausalRevision } from '@shared/api/group-client-views.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { GroupSnapshot, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import { toAppQueueCreatedBy, toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { AppOutboxType } from '../../app-outbox/app-outbox-type.ts';
import {
    COALESCED_APP_OUTBOX_WORK_FIELD,
    CoalescedAppOutboxWorkService,
    type CoalescedAppOutboxWorkData
} from '../../app-outbox/coalesced-app-outbox-work-service.ts';
import { toRtcRttMutationReceiptId } from '../../rtc-rtt/mutation/rtc-rtt-mutation-identifiers.ts';
import { toCanonicalRtcTopologyPairIdentity } from '../persistence/rtc-topology-identifiers.ts';
import {
    readRtcTopologyWorkEnvelope,
    toRtcTopologyQueueContextId,
    type RtcTopologyWorkEnvelope
} from '../replay/work/rtc-topology-work-codec.ts';
import { APP_OUTBOX_RTC_TOPOLOGY_TOPIC } from './rtc-topology-outbox-entry.ts';

export interface RtcTopologyGroupRevisionWork {
    readonly kind: 'group-revision';
    readonly overlayId: string;
    readonly groupSnapshot: GroupSnapshot;
    readonly sourceGroupStateCausalRevision: GroupStateCausalRevision;
    readonly requestedAtEpochMs: number;
    readonly requestOptions: CanonicalGroupTopologyConfigPatch;
    readonly origin: 'automatic' | 'commanded';
    readonly publish: boolean;
}

export interface RtcTopologyRttRefreshWork {
    readonly kind: 'rtt-refresh';
    readonly overlayId: string;
    readonly groupSnapshot: GroupSnapshot;
    readonly requestedGroupStateCausalRevision: GroupStateCausalRevision;
    readonly requestedRttVersion: number;
    readonly rtt: RttMeasurementInfo;
    readonly refinementObservationId: string;
    readonly requestedAtEpochMs: number;
    readonly requestOptions: CanonicalGroupTopologyConfigPatch;
    readonly publish: boolean;
}

export interface RtcTopologyStateMutationPublisher {
    enqueueForStateMutation(
        group: GroupSnapshot,
        deliveryId: string
    ): Promise<RtcTopologyGroupEnqueueResult>;
}

export interface RtcTopologyWorkPublisher extends RtcTopologyStateMutationPublisher {
    enqueueForGroupSnapshot(group: GroupSnapshot): Promise<void>;
    enqueueForRtt(group: GroupSnapshot, rtt: RttMeasurementInfo, debounceMs: number): Promise<void>;
    enqueueForRttGroups(
        rtt: RttMeasurementInfo,
        groups: readonly GroupSnapshot[],
        debounceMs: number
    ): Promise<void>;
}

export interface RtcTopologyGroupEnqueueResult {
    readonly effectiveCausalRevision: GroupStateCausalRevision;
}

export interface RtcTopologyWorkRuntime {
    readonly service: CoalescedAppOutboxWorkService;
    readonly outboxQueueReader: OutboxQueueReader;
    readonly publisher: RtcTopologyWorkPublisher;
    readonly workType: string;
    readonly topicId: string;
    readonly senderId: string;
}

interface CreateRtcTopologyWorkRuntimeOptions {
    readonly service: CoalescedAppOutboxWorkService;
    readonly outboxQueueReader: OutboxQueueReader;
    readonly senderId: string;
    readonly workType: string;
    readonly topicId: string;
    readonly wake?: () => void;
    readonly now?: () => number;
}

export interface CreateRtcTopologyOutboxPublisherOptions {
    readonly outboxQueueReader: OutboxQueueReader;
    readonly senderId?: string;
    readonly topicId?: string;
    readonly wake?: () => void;
    readonly now?: () => number;
}

export function createRtcTopologyOutboxPublisher(
    options: CreateRtcTopologyOutboxPublisherOptions
): RtcTopologyWorkRuntime {
    const senderId = options.senderId ?? 'rallar-server';
    return createRtcTopologyWorkRuntime({
        service: new CoalescedAppOutboxWorkService(
            options.outboxQueueReader,
            toAppQueueCreatedBy(senderId),
            options.now
        ),
        outboxQueueReader: options.outboxQueueReader,
        senderId,
        workType: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
        topicId: options.topicId ?? APP_OUTBOX_RTC_TOPOLOGY_TOPIC,
        wake: options.wake,
        now: options.now
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
    options: CreateRtcTopologyWorkRuntimeOptions
): RtcTopologyWorkRuntime {
    const now = options.now ?? (() => Date.now());

    const enqueueRtt = async (
        group: GroupSnapshot,
        rtt: RttMeasurementInfo,
        debounceMs: number
    ): Promise<void> => {
        const overlayId = toScopedOverlayId(group.group);
        const requestedGroupStateCausalRevision = readGroupCausalRevision(group);
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
                requestedGroupStateCausalRevision,
                requestedRttVersion: rtt.version,
                rtt,
                refinementObservationId: toRtcRttMutationReceiptId(rtt),
                requestedAtEpochMs,
                requestOptions: toCanonicalGroupTopologyConfigPatch({}),
                publish: true
            } satisfies RtcTopologyRttRefreshWork,
            reason: 'rtt',
            requestedAtEpochMs,
            dueAtEpochMs: requestedAtEpochMs + debounceMs,
            merge: mergeRtcTopologyRttWork
        } as const;
        const result = await options.service.enqueue(input);

        if (result.blockedByReserved) {
            await options.service.enqueue({
                ...input,
                resourceId: toRtcTopologyRttSuccessorResourceId(
                    overlayId,
                    requestedGroupStateCausalRevision,
                    rtt
                )
            });
        }
        options.wake?.();
    };

    const enqueueGroupSnapshot = async (
        group: GroupSnapshot,
        deliveryId?: string
    ): Promise<RtcTopologyGroupEnqueueResult> => {
        const overlayId = toScopedOverlayId(group.group);
        const sourceGroupStateCausalRevision = readGroupCausalRevision(group);
        const requestedAtEpochMs = now();
        const envelope: RtcTopologyWorkEnvelope<RtcTopologyGroupRevisionWork> = {
            type: options.workType,
            topicId: options.topicId,
            resourceId: deliveryId ?? toRtcTopologyGroupRevisionResourceId(
                overlayId,
                sourceGroupStateCausalRevision
            ),
            contextId: toRtcTopologyQueueContextId(group.group),
            senderId: toAppQueueCreatedBy(options.senderId),
            data: {
                kind: 'group-revision',
                overlayId,
                groupSnapshot: group,
                sourceGroupStateCausalRevision,
                requestedAtEpochMs,
                requestOptions: toCanonicalGroupTopologyConfigPatch({}),
                origin: 'automatic',
                publish: true
            }
        };
        const key = toAppQueueKey(envelope);
        const winner = await options.outboxQueueReader.enqueueIfAbsent(
            newALUntargetedMessage(
                toAppQueueCreatedBy(options.senderId),
                newALRoute(key.topicId, key.contextId, key.resourceId),
                options.workType,
                envelope
            )
        );
        options.wake?.();
        const winnerMessage = decodePersistedALMessage(winner.resource);
        const winnerEnvelope = readRtcTopologyWorkEnvelope(winnerMessage, options.workType);
        if (winnerEnvelope.data.kind !== 'group-revision') {
            throw new TypeError('RTC topology group enqueue resolved non-group work');
        }
        return {
            effectiveCausalRevision: winnerEnvelope.data.sourceGroupStateCausalRevision
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
        }
    };

    return {
        service: options.service,
        outboxQueueReader: options.outboxQueueReader,
        publisher,
        workType: options.workType,
        topicId: options.topicId,
        senderId: options.senderId
    };
}

function mergeRtcTopologyRttWork(
    existing: CoalescedAppOutboxWorkData<RtcTopologyRttRefreshWork>,
    incoming: CoalescedAppOutboxWorkData<RtcTopologyRttRefreshWork>
): CoalescedAppOutboxWorkData<RtcTopologyRttRefreshWork> {
    const previous = existing[COALESCED_APP_OUTBOX_WORK_FIELD];
    const next = incoming[COALESCED_APP_OUTBOX_WORK_FIELD];
    const selectedGroup = selectCausallyLatestRttWork(existing, incoming);
    const selectedRtt = existing.requestedRttVersion > incoming.requestedRttVersion ? existing : incoming;
    return {
        ...incoming,
        groupSnapshot: selectedGroup.groupSnapshot,
        requestedGroupStateCausalRevision: selectedGroup.requestedGroupStateCausalRevision,
        requestedRttVersion: Math.max(existing.requestedRttVersion, incoming.requestedRttVersion),
        rtt: selectedRtt.rtt,
        refinementObservationId: selectedRtt.refinementObservationId,
        requestedAtEpochMs: Math.max(existing.requestedAtEpochMs, incoming.requestedAtEpochMs),
        [COALESCED_APP_OUTBOX_WORK_FIELD]: {
            ...next,
            dueAtEpochMs: Math.max(previous.dueAtEpochMs, next.dueAtEpochMs),
            reasons: uniqueStrings([...previous.reasons, ...next.reasons])
        }
    };
}

function selectCausallyLatestRttWork(
    existing: CoalescedAppOutboxWorkData<RtcTopologyRttRefreshWork>,
    incoming: CoalescedAppOutboxWorkData<RtcTopologyRttRefreshWork>
): CoalescedAppOutboxWorkData<RtcTopologyRttRefreshWork> {
    const order = compareGroupCausalRevision(
        incoming.requestedGroupStateCausalRevision,
        existing.requestedGroupStateCausalRevision
    );
    if (order === 'incomparable') {
        throw new TypeError('RTC topology RTT work carries incomparable group causal revisions');
    }
    return order === 'dominated' ? existing : incoming;
}

function toRtcTopologyGroupRevisionResourceId(
    overlayId: string,
    causalRevision: GroupStateCausalRevision
): string {
    return `${overlayId}:group-revision:${toCausalRevisionIdentity(causalRevision)}`;
}

function toRtcTopologyRttSuccessorResourceId(
    overlayId: string,
    causalRevision: GroupStateCausalRevision,
    rtt: RttMeasurementInfo
): string {
    const pair = toCanonicalRtcTopologyPairIdentity(rtt.sessionIdFrom, rtt.sessionIdTo);
    return `${overlayId}:rtt:${toCausalRevisionIdentity(causalRevision)}:pair=${
        encodeURIComponent(pair)
    }:${rtt.version}`;
}

function toCausalRevisionIdentity(causalRevision: GroupStateCausalRevision): string {
    return `group=${causalRevision.groupRevision};presence=${causalRevision.presenceRevision}`;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
    return [...new Set(values)];
}
