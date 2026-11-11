import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import {
    type ALAckStatus,
    type ALPendingAckSnapshot
} from '../../../al-contracts/al-control.ts';
import { resolveALFrozenMulticastAudience } from '../../../al-contracts/al-frozen-multicast-audience.ts';
import { resolveALMessageExpireAtMs } from '../../../al-contracts/al-policy.ts';
import type { ALReceiptControl } from '../../../al-contracts/receipt-proof/al-receipt-proof.ts';
import { resolveExpireAtTimestampWithFallback } from '../../ALStoreRetention.ts';
import { isALRecipientConfirmationAck } from '../../delivery/is-al-recipient-confirmation-ack.ts';
import { isALCountedRecipient } from '../../delivery/resolve-al-counted-recipient-peer-ids.ts';
import type { ALInboundAdmissionMutation, ALInboundMessageReadDto } from '../al-inbound-admission-store.ts';
import { toALInboundMessageReference } from '../al-inbound-canonical-message.ts';
import { toALInboundAckEffect, type ALInboundEffectIntent } from '../al-inbound-effect-intent.ts';
import { toALDeliveryCarrier } from '../al-inbound-source-validation.ts';
import { toALInboundEffectId } from '../al-inbound-work-entry.ts';
import { isALSameReceiptStatement } from '../control/is-al-same-receipt-statement.ts';
import { isALPendingAckComplete, isALPendingAckUpwardRecipient } from '../transition-al-pending-ack.ts';
import { isALInboundNotSubscribedPlan } from './al-inbound-not-subscribed-plan.ts';

export interface ALInboundDuplicateChanges {
    readonly mutations: readonly ALInboundAdmissionMutation[];
    readonly effects: readonly ALInboundEffectIntent[];
}

export interface ComputeALInboundDuplicateChangesInput {
    readonly selfPeerId: string;
    /** Whether the parent the relay row records is still a member of the room and reachable. */
    readonly recordedParentPresent: boolean;
}

interface ALInboundRepeatedAck {
    readonly toPeerId: string;
    readonly status: ALAckStatus;
}

const NO_DUPLICATE_CHANGES: ALInboundDuplicateChanges = { mutations: [], effects: [] };

/**
 * A copy of a message this peer already admitted. It is never delivered again. A retried copy addressed to
 * this peer (D25): a peer with no relay row sends its own ACK again. A relay answers its parent in full:
 * every child control it already forwarded again, since any of them may be the one the origin lost, then its terminal
 * ACK when its subtree completed, or the copy onward to the child hops it still waits on. A sibling sender
 * gets the terminal ACK of this peer at once, so its own row completes whatever the visited exclusion
 * missed (R-S2c-ii-8c). The origin, or any sender once the recorded parent left, becomes the parent of
 * the row, and is answered in full (R-S2c-ii-12); a former parent still present then gets the sibling
 * answer (R-S2c-ii-14). A copy on the other carrier than the first admission -- the envelope a sender
 * re-admitted there after a hand-over (D56) -- gets the own ACK of this peer again over the carrier it came
 * in on, whatever its next hops and whether or not it holds a relay row: the first ACK went out on the
 * carrier the sender left (R-S3b-1), and a relay's forwarded ACKs stay on that first carrier (R-S3b-21). A peer
 * that answered `not-subscribed` ends its hop with an ACK that confirms nobody, and answers with that NACK again.
 */
export function computeALInboundDuplicateChanges(
    read: ALInboundMessageReadDto,
    input: ComputeALInboundDuplicateChangesInput
): ALInboundDuplicateChanges {
    const { plan, pendingAck } = read;
    const toPeerId = plan.ack.toPeerId;
    if (plan.dropReasonCode !== 'duplicate' || plan.ack.algo === 'none' || toPeerId === undefined) {
        return NO_DUPLICATE_CHANGES;
    }
    if (!isAddressedToSelf(read.msg, input.selfPeerId)) {
        return isCrossCarrierCopy(read)
            ? { mutations: [], effects: [toOwnRepeatedAck(read, toPeerId, input.selfPeerId)] }
            : NO_DUPLICATE_CHANGES;
    }
    if (pendingAck === undefined) {
        return { mutations: [], effects: [toOwnRepeatedAck(read, toPeerId, input.selfPeerId)] };
    }
    if (read.fromPeerId === pendingAck.toPeerId) {
        return { mutations: [], effects: toParentAnswer(read, pendingAck, input.selfPeerId) };
    }
    if (!isReparentingSender(read, pendingAck, input.recordedParentPresent)) {
        const status = pendingAck.status;
        const toSibling = { toPeerId: read.fromPeerId, status };
        return { mutations: [], effects: [toRepeatedAck(read, toSibling)] };
    }
    const reparented = { ...pendingAck, toPeerId: read.fromPeerId };
    return {
        mutations: [toReparentedRowMutation(read, reparented)],
        effects: [
            ...toParentAnswer(read, reparented, input.selfPeerId),
            ...(input.recordedParentPresent ? [toFormerParentRelease(read, pendingAck)] : [])
        ]
    };
}

/** A retried hop copy names this peer as its one next hop (D25). */
function isAddressedToSelf(msg: ALMessage, selfPeerId: string): boolean {
    const nextHopPeerIds = msg.forwarding?.nextHopPeerIds ?? [];
    return nextHopPeerIds.length === 1 && nextHopPeerIds[0] === selfPeerId;
}

/**
 * The message-owner row keeps the first admission's source, so a copy on the other carrier is told apart
 * from a retried copy on the same one. An owner row that already expired answers nothing, as before.
 */
function isCrossCarrierCopy(read: ALInboundMessageReadDto): boolean {
    const owner = read.observations.messageOwner;
    return owner !== undefined &&
        toALDeliveryCarrier(owner.source) !== toALDeliveryCarrier(read.source);
}

function toOwnRepeatedAck(
    read: ALInboundMessageReadDto,
    toPeerId: string,
    selfPeerId: string
): ALInboundEffectIntent {
    return toRepeatedAck(read, { toPeerId, status: toOwnAckStatus(read, selfPeerId) });
}

/**
 * A former parent that is still present waits on this peer as its child, which now answers another parent:
 * it gets the sibling answer, so its own row completes and its own delivery is still confirmed (R-S2c-ii-14).
 */
function toFormerParentRelease(read: ALInboundMessageReadDto, pendingAck: ALPendingAckSnapshot): ALInboundEffectIntent {
    return toRepeatedAck(read, { toPeerId: pendingAck.toPeerId, status: pendingAck.status });
}

/**
 * The origin is nobody's child, so its copy never comes from a sibling. Once the recorded parent left, the
 * sender is the parent of the new tree, unless it is a child hop of this peer, which would close a cycle.
 */
function isReparentingSender(
    read: ALInboundMessageReadDto,
    pendingAck: ALPendingAckSnapshot,
    recordedParentPresent: boolean
): boolean {
    if (read.fromPeerId === read.msg.id.senderId) {
        return true;
    }
    return !recordedParentPresent && !pendingAck.expectedFromPeerIds.includes(read.fromPeerId);
}

/**
 * Every child control the row forwarded upward again, then its terminal ACK once complete. While it still waits, a
 * recipient that delivered confirms itself again, since its `accepted` ACK may be the one the origin lost.
 */
function toParentAnswer(
    read: ALInboundMessageReadDto,
    pendingAck: ALPendingAckSnapshot,
    selfPeerId: string
): readonly ALInboundEffectIntent[] {
    const forwarded = toStoredUpwardControls(read, pendingAck)
        .map((control) => toRepeatedForward(read, pendingAck.toPeerId, control));
    if (isALPendingAckComplete(pendingAck)) {
        return [...forwarded, toRepeatedAck(read, { toPeerId: pendingAck.toPeerId, status: pendingAck.status })];
    }
    const owedPeerIds = toALPendingAckOwedPeerIds(pendingAck);
    return [
        ...forwarded,
        ...(isAcceptingRecipient(read, pendingAck, selfPeerId)
            ? [toRepeatedAck(read, { toPeerId: pendingAck.toPeerId, status: 'accepted' })]
            : []),
        ...(owedPeerIds.length === 0 ? [] : [toRetriedForward(read, owedPeerIds)])
    ];
}

/**
 * The stored child controls the row forwarded, each as its child sent it: each distinct statement of the confirming
 * ACKs that name an upward recipient, then per recipient recorded outside each distinct statement of the NACKs and
 * hop-ends that named it (S8ii-R1).
 */
function toStoredUpwardControls(
    read: ALInboundMessageReadDto,
    pendingAck: ALPendingAckSnapshot
): readonly ALReceiptControl[] {
    const confirmations = read.acks
        .filter((ack) =>
            isALRecipientConfirmationAck(ack) && isALPendingAckUpwardRecipient(pendingAck, ack.logicalRecipientPeerId)
        )
        .map((ack): ALReceiptControl => ({ type: 'ack', payload: ack }));
    const outside = pendingAck.outsideAudiencePeerIds.flatMap((peerId) => toStoredOutsideControls(read, peerId));
    return [...toFirstOfEachStatement(confirmations), ...outside];
}

/**
 * Each distinct statement that recorded a recipient outside, a NACK before a hop-end of the same statement; none once
 * all expired.
 */
function toStoredOutsideControls(read: ALInboundMessageReadDto, peerId: string): readonly ALReceiptControl[] {
    const nacks = read.nacks
        .filter((stored) => stored.logicalRecipientPeerId === peerId)
        .map((nack): ALReceiptControl => ({ type: 'nack', payload: nack }));
    const hopEnds = read.acks
        .filter((stored) =>
            stored.logicalRecipientPeerId === peerId && stored.status === 'subtree-complete-not-subscribed'
        )
        .map((hopEnd): ALReceiptControl => ({ type: 'ack', payload: hopEnd }));
    return toFirstOfEachStatement([...nacks, ...hopEnds]);
}

function toFirstOfEachStatement(controls: readonly ALReceiptControl[]): readonly ALReceiptControl[] {
    return controls.filter((control, index) =>
        controls.findIndex((prior) => isALSameReceiptStatement(prior.payload, control.payload)) === index
    );
}

/**
 * Whether this peer confirmed itself with `accepted` beside the row when it first admitted the message: it is a
 * logical recipient, one the frozen audience names or the unicast addresses, never a relay passing a copy on, nor
 * one whose row ends with a not-subscribed completion.
 */
function isAcceptingRecipient(
    read: ALInboundMessageReadDto,
    pendingAck: ALPendingAckSnapshot,
    selfPeerId: string
): boolean {
    return pendingAck.localReady && pendingAck.status === 'subtree-complete' &&
        isALCountedRecipient(read.msg, read.plan.ack.algo, selfPeerId);
}

/** Child hops a repeated parent copy can still forward to using the original canonical envelope. */
export function toALPendingAckOwedPeerIds(pendingAck: ALPendingAckSnapshot): readonly string[] {
    return pendingAck.expectedFromPeerIds.filter((peerId) => !pendingAck.ackedFromPeerIds.includes(peerId));
}

function toReparentedRowMutation(
    read: ALInboundMessageReadDto,
    pendingAck: ALPendingAckSnapshot
): ALInboundAdmissionMutation {
    return {
        kind: 'set-control-pending',
        msgId: read.msg.id.msgId,
        senderId: read.msg.id.senderId,
        value: { kind: 'pending', value: pendingAck },
        expireAtTimestamp: resolveExpireAtTimestampWithFallback(
            pendingAck.expireAtTimestamp,
            read.retention.controlPendingTtlMs,
            read.nowMs
        )
    };
}

/**
 * A peer outside the frozen audience, or not subscribed, delivered nothing: its ACK only ends its own empty subtree.
 * A frozen recipient whose first admission delivered nothing never confirms itself on a later copy either, whatever
 * the carrier it arrives on plans: the copy is a duplicate, so it is not delivered now.
 */
function toOwnAckStatus(read: ALInboundMessageReadDto, selfPeerId: string): ALAckStatus {
    if (isALInboundNotSubscribedPlan(read.plan)) {
        return 'subtree-complete-not-subscribed';
    }
    const frozen = resolveALFrozenMulticastAudience(read.msg.targets);
    if (frozen === undefined) {
        return 'delivered';
    }
    if (!frozen.recipientPeerIds.includes(selfPeerId)) {
        return 'subtree-complete';
    }
    return read.observations.messageOwner?.deliveredLocally === false ? 'subtree-complete-not-subscribed' : 'delivered';
}

function toRepeatedForward(
    read: ALInboundMessageReadDto,
    toPeerId: string,
    control: ALReceiptControl
): ALInboundEffectIntent {
    const effectId = toALInboundEffectId([
        'forward-control',
        read.msg.id.msgId,
        toPeerId,
        control.type,
        control.payload.logicalRecipientPeerId
    ]);
    return {
        effectId: toRetriedEffectId(effectId, read.nowMs),
        expireAtTimestamp: resolveALMessageExpireAtMs(read.msg, read.plan.effective),
        carrier: toALDeliveryCarrier(read.source),
        payload: { kind: 'forward-control', toPeerId, control }
    };
}

function toRepeatedAck(read: ALInboundMessageReadDto, repeated: ALInboundRepeatedAck): ALInboundEffectIntent {
    const ack = toALInboundAckEffect({
        ...repeated,
        ackedMsgId: read.msg.id.msgId,
        originPeerId: read.msg.id.senderId,
        expireAtTimestamp: resolveALMessageExpireAtMs(read.msg, read.plan.effective),
        carrier: toALDeliveryCarrier(read.source)
    });
    return { ...ack, effectId: toRetriedEffectId(ack.effectId, read.nowMs) };
}

function toRetriedForward(read: ALInboundMessageReadDto, owedPeerIds: readonly string[]): ALInboundEffectIntent {
    const { msg } = read;
    return {
        effectId: toRetriedEffectId(
            ['forward', msg.id.senderId, msg.id.msgId, read.fromPeerId].map(encodeURIComponent).join(':'),
            read.nowMs
        ),
        expireAtTimestamp: resolveALMessageExpireAtMs(msg, read.plan.effective),
        carrier: toALDeliveryCarrier(read.source),
        payload: {
            kind: 'forward-message',
            message: toALInboundMessageReference(msg),
            fromPeerId: read.fromPeerId,
            retryPeerIds: owedPeerIds
        }
    };
}

/** Each retried copy is its own arrival, so its work never collides with the rows the first copy wrote. */
function toRetriedEffectId(effectId: string, nowMs: number): string {
    return `${effectId}:retried:${nowMs}`;
}
