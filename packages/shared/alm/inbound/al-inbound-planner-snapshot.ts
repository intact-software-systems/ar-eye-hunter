import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../al-contracts/al-message-resource-limits.ts';
import type { ALMessageHandlingPlan, ALMessagePlanningObservations } from '../../al-contracts/al-policy.ts';
import type { ALOrderingTrackSnapshot } from '../../al-contracts/al-runtime.ts';
import type { ALBufferedOrderedMessageSnapshot } from '../al-runtime-state-stores.ts';
import { computeALOrderingObservation, type ALOrderingAcceptance } from '../compute-al-ordering-observation.ts';
import {
    acceptALSupersedenceObservation,
    computeALSupersedenceObservation,
    type ALSupersedenceAcceptance
} from '../compute-al-supersedence-observation.ts';
import type {
    ALInboundBufferedReleaseReadDto,
    ALInboundSupersedenceReadState
} from './al-inbound-admission-store.ts';

export interface ALInboundPlannerSnapshot {
    readonly msg: ALMessage;
    readonly prePlan: ALMessageHandlingPlan;
    readonly nowMs: number;
    readonly orderingTrackKey: string | undefined;
    readonly orderingSnapshot: ALOrderingTrackSnapshot | undefined;
    readonly bufferedSnapshots: readonly ALBufferedOrderedMessageSnapshot[];
    readonly orderingTrackTtlMs: number;
    readonly dedupExpiresAt: number | undefined;
    readonly supersedence: ALInboundSupersedenceReadState;
    readonly supersedenceTrackTtlMs: number;
    /** Replays have already committed deduplication and ordering admission. */
    readonly admitted: boolean;
}

export interface ALInboundStoredPlannerSnapshot {
    readonly msg: ALMessage;
    readonly nowMs: number;
    readonly supersedenceKey: string | null;
    readonly supersedence: ALInboundSupersedenceReadState;
    readonly supersedenceTrackTtlMs: number;
}

export function computeALInboundPlanningObservations(read: ALInboundPlannerSnapshot): ALMessagePlanningObservations {
    return {
        nowMs: read.nowMs,
        dedupSeen: !read.admitted && read.dedupExpiresAt !== undefined && read.dedupExpiresAt > read.nowMs,
        orderingObservation: read.admitted
            ? undefined
            : computeALInboundOrderingAcceptance(read, false).observation,
        supersedenceObservation: computeALSupersedenceObservation({
            supersedence: {
                key: read.prePlan.supersedence.key,
                msgId: read.msg.id.msgId,
                replacesMsgId: read.prePlan.supersedence.replacesMsgId,
                seq: read.msg.ordering?.seq,
                ts: read.msg.audit?.createdTs ?? read.msg.id.ts
            },
            latest: read.supersedence.latest,
            replacement: read.supersedence.replacement,
            nowMs: read.nowMs,
            trackTtlMs: read.supersedenceTrackTtlMs
        })
    };
}

export function computeALInboundStoredPlanningObservations(
    read: ALInboundStoredPlannerSnapshot
): ALMessagePlanningObservations {
    return {
        nowMs: read.nowMs,
        supersedenceObservation: read.supersedenceKey === null
            ? undefined
            : computeALSupersedenceObservation({
                supersedence: {
                    key: read.supersedenceKey,
                    msgId: read.msg.id.msgId,
                    seq: read.msg.ordering?.seq,
                    ts: read.msg.audit?.createdTs ?? read.msg.id.ts
                },
                latest: read.supersedence.latest,
                replacement: read.supersedence.replacement,
                nowMs: read.nowMs,
                trackTtlMs: read.supersedenceTrackTtlMs
            })
    };
}

export function computeALInboundBufferedReleasePlanningObservations(
    read: ALInboundBufferedReleaseReadDto
): ALMessagePlanningObservations {
    return {
        nowMs: read.nowMs,
        supersedenceObservation: computeALInboundBufferedReleaseSupersedenceAcceptance(read)?.observation
    };
}

export function computeALInboundBufferedReleaseSupersedenceAcceptance(
    read: ALInboundBufferedReleaseReadDto
): ALSupersedenceAcceptance | undefined {
    if (!read.snapshot.plan.supersedence.enabled || !read.snapshot.plan.supersedence.key) {
        return undefined;
    }
    return acceptALSupersedenceObservation({
        supersedence: {
            key: read.snapshot.plan.supersedence.key,
            msgId: read.snapshot.msg.id.msgId,
            replacesMsgId: read.snapshot.plan.supersedence.replacesMsgId,
            seq: read.snapshot.msg.ordering?.seq,
            ts: read.snapshot.msg.audit?.createdTs ?? read.snapshot.msg.id.ts
        },
        latest: read.supersedence.latest,
        replacement: read.supersedence.replacement,
        nowMs: read.nowMs,
        trackTtlMs: read.supersedenceTrackTtlMs
    });
}

export function computeALInboundOrderingAcceptance(
    read: ALInboundPlannerSnapshot,
    apply: boolean
): ALOrderingAcceptance {
    const ordering = computeALOrderingObservation({
        snapshot: read.orderingSnapshot,
        msg: read.msg,
        nowMs: read.nowMs,
        trackTtlMs: read.orderingTrackTtlMs,
        apply
    });
    if (
        !read.prePlan.localDelivery.enabled ||
        (ordering.observation.status !== 'gap' && ordering.observation.status !== 'in-order') ||
        canRetainOrderedMessage(read)
    ) {
        return ordering;
    }
    return {
        observation: { ...ordering.observation, status: 'resync-required', missingSeqs: [], releasableSeqs: [] }
    };
}

function canRetainOrderedMessage(read: ALInboundPlannerSnapshot): boolean {
    if (read.bufferedSnapshots.length >= AL_MESSAGE_RESOURCE_LIMITS.bufferedMessages) {
        return false;
    }
    const encoder = new TextEncoder();
    let bytes = encoder.encode(JSON.stringify(read.msg)).length;
    for (const buffered of read.bufferedSnapshots) {
        bytes += encoder.encode(JSON.stringify(buffered.msg)).length;
        if (bytes > AL_MESSAGE_RESOURCE_LIMITS.bufferedBytes) {
            return false;
        }
    }
    return bytes <= AL_MESSAGE_RESOURCE_LIMITS.bufferedBytes;
}
