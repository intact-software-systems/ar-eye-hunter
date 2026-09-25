import type {
    ALAckPayload,
    ALCompletedPendingAck,
    ALPendingAckSnapshot
} from '../../al-contracts/al-control.ts';
import type { ALDeliveryCarrier } from '../delivery/al-delivery-lifecycle.ts';

export interface TrackALPendingAckSnapshotInput {
    readonly msgId: string;
    readonly current: ALPendingAckSnapshot | undefined;
    readonly acks: readonly ALAckPayload[];
    readonly toPeerId: string;
    readonly expectedFromPeerIds: readonly string[];
    readonly localReady: boolean;
    readonly localRecipient: boolean;
    readonly expireAtTimestamp: number | undefined;
    readonly carrier: ALDeliveryCarrier;
}

export interface MarkALPendingAckLocalReadySnapshotInput {
    readonly msgId: string;
    readonly current: ALPendingAckSnapshot | undefined;
    readonly acks: readonly ALAckPayload[];
}

export interface AcceptALPendingAckPayloadInput {
    readonly current: ALPendingAckSnapshot | undefined;
    readonly nextAcks: readonly ALAckPayload[];
    readonly ack: ALAckPayload;
}

export interface ALPendingAckTransition {
    readonly pending?: ALPendingAckSnapshot;
    readonly completed?: ALCompletedPendingAck;
    /** The logical recipients the counted ACKs confirmed, each once (D40); empty while pending. */
    readonly completedRecipientPeerIds: readonly string[];
    /** The completion also speaks for this relay: it is a logical recipient and delivered locally. */
    readonly completedLocalRecipient: boolean;
}

const NO_AL_PENDING_ACK_TRANSITION: ALPendingAckTransition = {
    completedRecipientPeerIds: [],
    completedLocalRecipient: false
};

export function trackALPendingAckSnapshot(
    input: TrackALPendingAckSnapshotInput
): ALPendingAckTransition {
    const expireAtTimestamp = input.expireAtTimestamp ?? input.current?.expireAtTimestamp;
    const expectedFromPeerIds = new Set(input.current?.expectedFromPeerIds ?? []);
    for (const peerId of input.expectedFromPeerIds) {
        expectedFromPeerIds.add(peerId);
    }

    const ackedFromPeerIds = new Set(input.current?.ackedFromPeerIds ?? []);
    const countedAcks = input.acks.filter((ack) =>
        expectedFromPeerIds.size === 0 || expectedFromPeerIds.has(ack.fromPeerId)
    );
    for (const ack of countedAcks) {
        ackedFromPeerIds.add(ack.fromPeerId);
    }

    return finalizeALPendingAckTransition(input.msgId, countedAcks, {
        toPeerId: input.toPeerId,
        status: 'subtree-complete',
        localReady: (input.current?.localReady ?? false) || input.localReady,
        localRecipient: (input.current?.localRecipient ?? false) || input.localRecipient,
        expectedFromPeerIds: [...expectedFromPeerIds],
        ackedFromPeerIds: [...ackedFromPeerIds],
        ...(expireAtTimestamp === undefined ? {} : { expireAtTimestamp }),
        carrier: input.carrier
    });
}

export function markALPendingAckLocalReadySnapshot(
    input: MarkALPendingAckLocalReadySnapshotInput
): ALPendingAckTransition {
    if (!input.current) {
        return NO_AL_PENDING_ACK_TRANSITION;
    }

    return trackALPendingAckSnapshot({
        msgId: input.msgId,
        current: input.current,
        acks: input.acks,
        toPeerId: input.current.toPeerId,
        expectedFromPeerIds: input.current.expectedFromPeerIds,
        localReady: true,
        localRecipient: input.current.localRecipient,
        expireAtTimestamp: input.current.expireAtTimestamp,
        carrier: input.current.carrier
    });
}

export function acceptALPendingAckPayload(
    input: AcceptALPendingAckPayloadInput
): ALPendingAckTransition {
    if (!input.current) {
        return NO_AL_PENDING_ACK_TRANSITION;
    }

    const ackedFromPeerIds = new Set(input.current.ackedFromPeerIds);
    if (
        input.current.expectedFromPeerIds.length === 0 ||
        input.current.expectedFromPeerIds.includes(input.ack.fromPeerId)
    ) {
        ackedFromPeerIds.add(input.ack.fromPeerId);
    }

    return trackALPendingAckSnapshot({
        msgId: input.ack.ackedMsgId,
        current: { ...input.current, ackedFromPeerIds: [...ackedFromPeerIds] },
        acks: input.nextAcks,
        toPeerId: input.current.toPeerId,
        expectedFromPeerIds: input.current.expectedFromPeerIds,
        localReady: input.current.localReady,
        localRecipient: input.current.localRecipient,
        expireAtTimestamp: input.current.expireAtTimestamp,
        carrier: input.current.carrier
    });
}

function finalizeALPendingAckTransition(
    msgId: string,
    countedAcks: readonly ALAckPayload[],
    pending: ALPendingAckSnapshot
): ALPendingAckTransition {
    if (!pending.localReady) {
        return { pending, completedRecipientPeerIds: [], completedLocalRecipient: false };
    }

    const ackedFromPeerIds = new Set(pending.ackedFromPeerIds);
    const isComplete = pending.expectedFromPeerIds.length === 0 ||
        pending.expectedFromPeerIds.every((peerId) => ackedFromPeerIds.has(peerId));
    return isComplete
        ? {
            completed: {
                msgId,
                toPeerId: pending.toPeerId,
                status: pending.status,
                ...(pending.expireAtTimestamp === undefined ? {} : { expireAtTimestamp: pending.expireAtTimestamp })
            },
            completedRecipientPeerIds: [...new Set(countedAcks.map((ack) => ack.logicalRecipientPeerId))],
            completedLocalRecipient: pending.localRecipient
        }
        : { pending, completedRecipientPeerIds: [], completedLocalRecipient: false };
}
