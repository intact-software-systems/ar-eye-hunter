import { resolveALMessageExpireAtMs } from '../../../al-contracts/al-policy.ts';
import type { ALInboundMessageReadDto } from '../al-inbound-admission-store.ts';
import { toALInboundMessageReference } from '../al-inbound-canonical-message.ts';
import { toALInboundAckEffect, type ALInboundEffectIntent } from '../al-inbound-effect-intent.ts';
import { toALDeliveryCarrier } from '../al-inbound-source-validation.ts';
import { isALPendingAckComplete } from '../transition-al-pending-ack.ts';

/**
 * A retried copy of a message this peer already admitted, addressed to this peer (D25). It is never
 * delivered again: a peer with no relay row sends its own ACK again, a relay whose subtree completed
 * sends its terminal ACK again, and a relay still owed a child hop forwards the copy to those hops only.
 */
export function computeALInboundDuplicateEffects(
    read: ALInboundMessageReadDto,
    selfPeerId: string
): readonly ALInboundEffectIntent[] {
    const { msg, plan, pendingAck } = read;
    const toPeerId = plan.ack.toPeerId;
    const nextHopPeerIds = msg.forwarding?.nextHopPeerIds ?? [];
    if (
        plan.dropReasonCode !== 'duplicate' || plan.ack.algo === 'none' || toPeerId === undefined ||
        nextHopPeerIds.length !== 1 || nextHopPeerIds[0] !== selfPeerId
    ) {
        return [];
    }
    if (pendingAck === undefined || isALPendingAckComplete(pendingAck)) {
        return [toRepeatedOwnAck(read, pendingAck === undefined ? toPeerId : pendingAck.toPeerId)];
    }
    const owedPeerIds = pendingAck.expectedFromPeerIds.filter((peerId) =>
        !pendingAck.ackedFromPeerIds.includes(peerId)
    );
    return [{
        effectId: toRetriedEffectId(
            ['forward', msg.id.senderId, msg.id.msgId, read.fromPeerId].map(encodeURIComponent).join(':'),
            read.nowMs
        ),
        expireAtTimestamp: resolveALMessageExpireAtMs(msg, plan.effective),
        carrier: toALDeliveryCarrier(read.source),
        payload: {
            kind: 'forward-message',
            message: toALInboundMessageReference(msg),
            fromPeerId: read.fromPeerId,
            retryPeerIds: owedPeerIds
        }
    }];
}

function toRepeatedOwnAck(read: ALInboundMessageReadDto, toPeerId: string): ALInboundEffectIntent {
    const ack = toALInboundAckEffect({
        toPeerId,
        ackedMsgId: read.msg.id.msgId,
        originPeerId: read.msg.id.senderId,
        logicalRecipient: { kind: 'self' },
        status: read.pendingAck === undefined ? 'delivered' : read.pendingAck.status,
        expireAtTimestamp: resolveALMessageExpireAtMs(read.msg, read.plan.effective),
        carrier: toALDeliveryCarrier(read.source)
    });
    return { ...ack, effectId: toRetriedEffectId(ack.effectId, read.nowMs) };
}

/** Each retried copy is its own arrival, so its work never collides with the rows the first copy wrote. */
function toRetriedEffectId(effectId: string, nowMs: number): string {
    return `${effectId}:retried:${nowMs}`;
}
