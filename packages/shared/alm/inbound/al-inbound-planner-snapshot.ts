import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../al-contracts/al-message-resource-limits.ts';
import type { ALMessageHandlingPlan, ALMessagePlanningObservations } from '../../al-contracts/al-policy.ts';
import type { ALOrderingObservationStatus, ALOrderingTrackSnapshot } from '../../al-contracts/al-runtime.ts';
import type { ALBufferedOrderedMessageSnapshot } from '../al-runtime-state-stores.ts';
import { computeALOrderingObservation, type ALOrderingAcceptance } from '../compute-al-ordering-observation.ts';
import {
    acceptALSupersedenceObservation,
    computeALSupersedenceObservation,
    type ALSupersedenceAcceptance
} from '../compute-al-supersedence-observation.ts';
import { isALInboundDeliveringPlan } from './admission/al-inbound-not-subscribed-plan.ts';
import {
    resolveALOrderingObserverRole,
    type ALOrderingObserver
} from './admission/resolve-al-ordering-observer-role.ts';
import type {
    ALInboundBufferedReleaseReadDto,
    ALInboundOrderedDeliveryRead,
    ALInboundSupersedenceReadState
} from './al-inbound-admission-store.ts';
import type { ALInboundOrderedDelivery } from './al-inbound-ordered-delivery.ts';

export interface ALInboundPlannerSnapshot {
    readonly msg: ALMessage;
    readonly prePlan: ALMessageHandlingPlan;
    readonly nowMs: number;
    readonly selfPeerId: string;
    readonly orderingObserver: ALOrderingObserver;
    readonly orderingTrackKey: string | undefined;
    readonly orderingSnapshot: ALOrderingTrackSnapshot | undefined;
    readonly bufferedSnapshots: readonly ALBufferedOrderedMessageSnapshot[];
    readonly orderingTrackTtlMs: number;
    readonly dedupExpiresAt: number | undefined;
    /** The session holding a live claim on an exclusive message's resource key; never read for any other message. */
    readonly claimHolderPeerId: string | undefined;
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
        claimHolderPeerId: read.admitted ? undefined : read.claimHolderPeerId,
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
        apply,
        role: resolveALOrderingObserverRole({
            msg: read.msg,
            selfPeerId: read.selfPeerId,
            delivering: isALInboundDeliveringPlan(read.prePlan),
            observer: read.orderingObserver
        }),
        selfPeerId: read.selfPeerId,
        bufferedPriorSeqs: toBufferedPriorSeqs(read)
    });
    if (
        !read.prePlan.localDelivery.enabled ||
        !RETAINED_ORDERING_STATUSES.has(ordering.observation.status) ||
        canRetainOrderedMessage(read)
    ) {
        return ordering;
    }
    return {
        observation: { ...ordering.observation, status: 'resync-required', missingRanges: [], releasableSeqs: [] }
    };
}

/** The statuses that retain the copy in a buffered slot until its delivery: delivered now, or held for a gap. */
const RETAINED_ORDERING_STATUSES: ReadonlySet<ALOrderingObservationStatus> = new Set([
    'gap',
    'in-order',
    'entered',
    'omitted'
]);

/** Each buffered copy's own prior for this receiver, from the record it carries. */
function toBufferedPriorSeqs(read: ALInboundPlannerSnapshot): Readonly<Record<number, number>> {
    const priorSeqs: Record<number, number> = {};
    for (const buffered of read.bufferedSnapshots) {
        const record = buffered.msg.ordering?.priorSeqByRecipient;
        if (record !== undefined) {
            priorSeqs[buffered.seq] = record[read.selfPeerId] ?? buffered.seq - 1;
        }
    }
    return priorSeqs;
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

export interface ALInboundPredecessorRead {
    readonly orderedDelivery: ALInboundOrderedDeliveryRead;
    readonly seq: number;
}

export function computeALInboundPredecessorReadiness(
    read: ALInboundPredecessorRead
): ALInboundOrderedDelivery.Readiness {
    const { orderedDelivery, seq } = read;
    if (seq <= orderedDelivery.completedThrough) {
        return { kind: 'completed' };
    }
    const predecessor = orderedDelivery.predecessor;
    if (predecessor === undefined) {
        return { kind: 'ready' };
    }
    if (predecessor.kind === 'effect') {
        return { kind: 'waiting' };
    }
    return { kind: 'resync-required', completedThrough: orderedDelivery.completedThrough };
}
