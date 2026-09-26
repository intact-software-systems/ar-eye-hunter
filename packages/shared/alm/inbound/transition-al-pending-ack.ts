import {
    isALHopCompletionAck,
    type ALAckPayload,
    type ALCompletedPendingAck,
    type ALPendingAckSnapshot
} from '../../al-contracts/al-control.ts';
import type { ALDeliveryCarrier } from '../delivery/al-delivery-lifecycle.ts';

export interface TrackALPendingAckSnapshotInput {
    readonly msgId: string;
    readonly current: ALPendingAckSnapshot | undefined;
    readonly toPeerId: string;
    readonly expectedFromPeerIds: readonly string[];
    readonly localReady: boolean;
    readonly expireAtTimestamp: number | undefined;
    readonly carrier: ALDeliveryCarrier;
}

export interface MarkALPendingAckLocalReadySnapshotInput {
    readonly msgId: string;
    readonly current: ALPendingAckSnapshot | undefined;
}

export interface AcceptALPendingAckPayloadInput {
    readonly current: ALPendingAckSnapshot | undefined;
    readonly ack: ALAckPayload;
}

export interface ALPendingAckTransition {
    /** The row after this transition; absent only when there was no row to move. */
    readonly pending: ALPendingAckSnapshot | undefined;
    /** Set by the one transition that completed the row: its terminal ACK goes upward after the relayed ones. */
    readonly completed: ALCompletedPendingAck | undefined;
    /** The recipients this transition relays upward, one ACK each (D40). */
    readonly relayedRecipientPeerIds: readonly string[];
}

interface ALPendingAckTransitionInput {
    readonly msgId: string;
    readonly previous: ALPendingAckSnapshot | undefined;
    readonly pending: ALPendingAckSnapshot;
    readonly relayedRecipientPeerIds: readonly string[];
}

const NO_AL_PENDING_ACK_TRANSITION: ALPendingAckTransition = {
    pending: undefined,
    completed: undefined,
    relayedRecipientPeerIds: []
};

export function trackALPendingAckSnapshot(
    input: TrackALPendingAckSnapshotInput
): ALPendingAckTransition {
    const expireAtTimestamp = input.expireAtTimestamp ?? input.current?.expireAtTimestamp;
    return toALPendingAckTransition({
        msgId: input.msgId,
        previous: input.current,
        pending: {
            toPeerId: input.toPeerId,
            status: 'subtree-complete',
            localReady: (input.current?.localReady ?? false) || input.localReady,
            expectedFromPeerIds: [
                ...new Set([...input.current?.expectedFromPeerIds ?? [], ...input.expectedFromPeerIds])
            ],
            ackedFromPeerIds: input.current?.ackedFromPeerIds ?? [],
            ...(expireAtTimestamp === undefined ? {} : { expireAtTimestamp }),
            carrier: input.carrier
        },
        relayedRecipientPeerIds: []
    });
}

export function markALPendingAckLocalReadySnapshot(
    input: MarkALPendingAckLocalReadySnapshotInput
): ALPendingAckTransition {
    return input.current === undefined
        ? NO_AL_PENDING_ACK_TRANSITION
        : toALPendingAckTransition({
            msgId: input.msgId,
            previous: input.current,
            pending: { ...input.current, localReady: true },
            relayedRecipientPeerIds: []
        });
}

/** Every admitted child ACK is relayed upward; only the completion ACK of the child hop itself completes it. */
export function acceptALPendingAckPayload(
    input: AcceptALPendingAckPayloadInput
): ALPendingAckTransition {
    const { current, ack } = input;
    if (current === undefined) {
        return NO_AL_PENDING_ACK_TRANSITION;
    }
    const ackedFromPeerIds = isALHopCompletionAck(ack)
        ? [...new Set([...current.ackedFromPeerIds, ack.fromPeerId])]
        : current.ackedFromPeerIds;
    return toALPendingAckTransition({
        msgId: ack.ackedMsgId,
        previous: current,
        pending: { ...current, ackedFromPeerIds },
        relayedRecipientPeerIds: [ack.logicalRecipientPeerId]
    });
}

export function isALPendingAckComplete(pending: ALPendingAckSnapshot): boolean {
    const ackedFromPeerIds = new Set(pending.ackedFromPeerIds);
    return pending.localReady && pending.expectedFromPeerIds.every((peerId) => ackedFromPeerIds.has(peerId));
}

function toALPendingAckTransition(input: ALPendingAckTransitionInput): ALPendingAckTransition {
    const { msgId, previous, pending, relayedRecipientPeerIds } = input;
    const completes = isALPendingAckComplete(pending) && (previous === undefined || !isALPendingAckComplete(previous));
    return {
        pending,
        completed: completes
            ? {
                msgId,
                toPeerId: pending.toPeerId,
                status: pending.status,
                ...(pending.expireAtTimestamp === undefined ? {} : { expireAtTimestamp: pending.expireAtTimestamp })
            }
            : undefined,
        relayedRecipientPeerIds
    };
}
