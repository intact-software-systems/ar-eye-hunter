import type { ALAckStatus, ALPendingAckSnapshot } from '../../../al-contracts/al-control.ts';
import { resolveALFrozenMulticastAudience } from '../../../al-contracts/al-frozen-multicast-audience.ts';
import { resolveALMessageExpireAtMs } from '../../../al-contracts/al-policy.ts';
import type { ALInboundMessageReadDto } from '../al-inbound-admission-store.ts';
import { toALInboundMessageReference } from '../al-inbound-canonical-message.ts';
import {
    toALInboundAckEffect,
    type ALInboundAckRecipient,
    type ALInboundEffectIntent
} from '../al-inbound-effect-intent.ts';
import { toALDeliveryCarrier } from '../al-inbound-source-validation.ts';
import { isALPendingAckComplete } from '../transition-al-pending-ack.ts';

interface ALInboundRepeatedAck {
    readonly toPeerId: string;
    readonly logicalRecipient: ALInboundAckRecipient;
    readonly status: ALAckStatus;
}

/**
 * A retried copy of a message this peer already admitted, addressed to this peer (D25). It is never
 * delivered again. A peer with no relay row sends its own ACK again. A relay answering its recorded parent
 * sends again every ACK it already relayed, since any of them may be the one the origin lost, and then its
 * terminal ACK when its subtree completed, or the copy onward to the child hops it still waits on.
 * Any other sender only relayed to a hop another parent already owns (R-S2c-ii-8c): it gets the terminal
 * ACK of this peer at once, so its own row completes whatever the visited exclusion missed.
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
    if (pendingAck === undefined) {
        return [toRepeatedAck(read, {
            toPeerId,
            logicalRecipient: { kind: 'self' },
            status: toOwnAckStatus(read, selfPeerId)
        })];
    }
    return toRelayDuplicateEffects(read, pendingAck);
}

/** A relay answers a retried copy from its recorded parent in full, and any other sender with its terminal ACK. */
function toRelayDuplicateEffects(
    read: ALInboundMessageReadDto,
    pendingAck: ALPendingAckSnapshot
): readonly ALInboundEffectIntent[] {
    if (read.fromPeerId !== pendingAck.toPeerId) {
        return [
            toRepeatedAck(read, {
                toPeerId: read.fromPeerId,
                logicalRecipient: { kind: 'self' },
                status: pendingAck.status
            })
        ];
    }
    const relayed = [...new Set(read.acks.map((ack) => ack.logicalRecipientPeerId))].map((peerId) =>
        toRepeatedAck(read, {
            toPeerId: pendingAck.toPeerId,
            logicalRecipient: { kind: 'relayed', peerId },
            status: 'forwarded'
        })
    );
    if (isALPendingAckComplete(pendingAck)) {
        return [
            ...relayed,
            toRepeatedAck(read, {
                toPeerId: pendingAck.toPeerId,
                logicalRecipient: { kind: 'self' },
                status: pendingAck.status
            })
        ];
    }
    const owedPeerIds = pendingAck.expectedFromPeerIds.filter((peerId) =>
        !pendingAck.ackedFromPeerIds.includes(peerId)
    );
    return owedPeerIds.length === 0 ? relayed : [...relayed, toRetriedForward(read, owedPeerIds)];
}

/** A peer outside the frozen audience delivered nothing: its ACK only ends its own empty subtree. */
function toOwnAckStatus(read: ALInboundMessageReadDto, selfPeerId: string): ALAckStatus {
    const frozen = resolveALFrozenMulticastAudience(read.msg.targets);
    return frozen === undefined || frozen.recipientPeerIds.includes(selfPeerId) ? 'delivered' : 'subtree-complete';
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
