import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALDeliveryCarrier } from '../../al-contracts/al-control-value-codec.ts';
import {
    isALHopCompletionAck,
    type ALAckPayload,
    type ALAckStatus,
    type ALCompletedPendingAck,
    type ALNackPayload,
    type ALPendingAckSnapshot
} from '../../al-contracts/al-control.ts';
import type { ALAckAlgo } from '../../al-contracts/al-policy.ts';
import { isALImpliedNotSubscribedNack } from '../delivery/is-al-implied-not-subscribed-nack.ts';
import { isALRecipientConfirmationAck } from '../delivery/is-al-recipient-confirmation-ack.ts';
import { resolveALCountedRecipientPeerIds } from '../delivery/resolve-al-counted-recipient-peer-ids.ts';

export interface TrackALPendingAckSnapshotInput {
    readonly msgId: string;
    readonly current: ALPendingAckSnapshot | undefined;
    readonly toPeerId: string;
    /** The status of the terminal ACK the row ends its hop with. */
    readonly status: ALAckStatus;
    readonly expectedFromPeerIds: readonly string[];
    readonly localReady: boolean;
    readonly expireAtTimestamp: number | undefined;
    readonly carrier: ALDeliveryCarrier;
    /** `undefined` relays every child ACK upward; see `resolveALUpwardAudiencePeerIds`. */
    readonly upwardAudiencePeerIds: readonly string[] | undefined;
}

export interface MarkALPendingAckLocalReadySnapshotInput {
    readonly msgId: string;
    readonly current: ALPendingAckSnapshot | undefined;
}

export interface AcceptALPendingAckPayloadInput {
    readonly current: ALPendingAckSnapshot | undefined;
    /** The child ACKs the row admitted before this one. */
    readonly acks: readonly ALAckPayload[];
    readonly ack: ALAckPayload;
}

export interface ALPendingAckTransition {
    /** The row after this transition; absent only when there was no row to move. */
    readonly pending: ALPendingAckSnapshot | undefined;
    /** Set by the one transition that completed the row: its terminal ACK goes upward after the relayed ones. */
    readonly completed: ALCompletedPendingAck | undefined;
    /** The recipients this transition relays upward, one ACK each (D40). */
    readonly relayedRecipientPeerIds: readonly string[];
    /** The recipients this transition records outside the audience; the relay forwards the hop-end that implied it. */
    readonly relayedOutsidePeerIds: readonly string[];
}

interface ALPendingAckTransitionInput {
    readonly msgId: string;
    readonly previous: ALPendingAckSnapshot | undefined;
    readonly pending: ALPendingAckSnapshot;
    readonly relayedRecipientPeerIds: readonly string[];
    readonly relayedOutsidePeerIds: readonly string[];
}

const NO_AL_PENDING_ACK_TRANSITION: ALPendingAckTransition = {
    pending: undefined,
    completed: undefined,
    relayedRecipientPeerIds: [],
    relayedOutsidePeerIds: []
};

export function trackALPendingAckSnapshot(
    input: TrackALPendingAckSnapshotInput
): ALPendingAckTransition {
    const expireAtTimestamp = input.expireAtTimestamp ?? input.current?.expireAtTimestamp;
    const upwardAudiencePeerIds = input.upwardAudiencePeerIds ?? input.current?.upwardAudiencePeerIds;
    return toALPendingAckTransition({
        msgId: input.msgId,
        previous: input.current,
        pending: {
            toPeerId: input.toPeerId,
            status: input.status,
            localReady: (input.current?.localReady ?? false) || input.localReady,
            expectedFromPeerIds: [
                ...new Set([...input.current?.expectedFromPeerIds ?? [], ...input.expectedFromPeerIds])
            ],
            ackedFromPeerIds: input.current?.ackedFromPeerIds ?? [],
            ...(expireAtTimestamp === undefined ? {} : { expireAtTimestamp }),
            ...(upwardAudiencePeerIds === undefined ? {} : { upwardAudiencePeerIds }),
            outsideAudiencePeerIds: input.current?.outsideAudiencePeerIds ?? [],
            carrier: input.carrier
        },
        relayedRecipientPeerIds: [],
        relayedOutsidePeerIds: []
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
            relayedRecipientPeerIds: [],
            relayedOutsidePeerIds: []
        });
}

/**
 * The audience whose child ACKs a relay passes upward: the recipients a `receiver` or `leader` multicast counts, since
 * its origin counts nobody else; `undefined`, relaying every child ACK, for any other send. A unicast keeps
 * `undefined`, as before.
 */
export function resolveALUpwardAudiencePeerIds(msg: ALMessage, algo: ALAckAlgo): readonly string[] | undefined {
    return msg.targets?.mode === 'unicast' ? undefined : resolveALCountedRecipientPeerIds(msg, algo);
}

export function isALPendingAckUpwardRecipient(pending: ALPendingAckSnapshot, recipientPeerId: string): boolean {
    return pending.upwardAudiencePeerIds === undefined || pending.upwardAudiencePeerIds.includes(recipientPeerId);
}

/**
 * An admitted child ACK is relayed upward when it confirms a recipient the origin counts and no earlier child ACK
 * named it already: a recipient relay's terminal ACK follows its `accepted` one. Only the completion ACK of the child
 * hop itself completes it, a not-subscribed one's included. A hop-end that confirms nobody for a recipient the row
 * still owes implies that recipient's `not-subscribed` NACK: the row records it outside and the relay forwards the
 * hop-end as it came, so a lost NACK still reaches the origin, as a delivering relay's terminal ACK still confirms it
 * when its `accepted` one was lost (R-S2c-ii-14).
 */
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
    const relayed = isALRecipientConfirmationAck(ack) &&
        isALPendingAckUpwardRecipient(current, ack.logicalRecipientPeerId) &&
        !input.acks.some((prior) => prior.logicalRecipientPeerId === ack.logicalRecipientPeerId);
    const outside = isALImpliedNotSubscribedNack(ack, toOwedUpwardRecipientPeerIds(current, input.acks));
    return toALPendingAckTransition({
        msgId: ack.ackedMsgId,
        previous: current,
        pending: {
            ...current,
            ackedFromPeerIds,
            outsideAudiencePeerIds: outside
                ? [...current.outsideAudiencePeerIds, ack.logicalRecipientPeerId]
                : current.outsideAudiencePeerIds
        },
        relayedRecipientPeerIds: relayed ? [ack.logicalRecipientPeerId] : [],
        relayedOutsidePeerIds: outside ? [ack.logicalRecipientPeerId] : []
    });
}

/** The frozen recipients of the row's upward audience not yet recorded outside, and never confirmed. */
function toOwedUpwardRecipientPeerIds(
    current: ALPendingAckSnapshot,
    acks: readonly ALAckPayload[]
): readonly string[] {
    return (current.upwardAudiencePeerIds ?? []).filter((recipientPeerId) =>
        !current.outsideAudiencePeerIds.includes(recipientPeerId) &&
        !acks.some((prior) => prior.logicalRecipientPeerId === recipientPeerId && isALRecipientConfirmationAck(prior))
    );
}

/**
 * An admitted outside-audience NACK names a recipient that delivered nothing, which the row relays upward and records.
 * It completes no hop: the child's own hop-completion ACK does, once its subtree answered.
 */
export function acceptALPendingOutsideAudienceNack(
    current: ALPendingAckSnapshot,
    nack: ALNackPayload
): ALPendingAckSnapshot {
    return { ...current, outsideAudiencePeerIds: [...current.outsideAudiencePeerIds, nack.logicalRecipientPeerId] };
}

export function isALPendingAckComplete(pending: ALPendingAckSnapshot): boolean {
    const ackedFromPeerIds = new Set(pending.ackedFromPeerIds);
    return pending.localReady && pending.expectedFromPeerIds.every((peerId) => ackedFromPeerIds.has(peerId));
}

function toALPendingAckTransition(input: ALPendingAckTransitionInput): ALPendingAckTransition {
    const { msgId, previous, pending, relayedRecipientPeerIds, relayedOutsidePeerIds } = input;
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
        relayedRecipientPeerIds,
        relayedOutsidePeerIds
    };
}
