import { resolveALMessageExpireAtMs } from '../../../al-contracts/al-policy.ts';
import { resolveExpireAtTimestampWithFallback } from '../../ALStoreRetention.ts';
import type { ALInboundAdmissionMutation, ALInboundMessageReadDto } from '../al-inbound-admission-store.ts';
import { toALInboundAckEffect, type ALInboundEffectIntent } from '../al-inbound-effect-intent.ts';
import type { ALInboundOrderedDeliverySnapshot } from '../al-inbound-ordering-validation.ts';
import { toALDeliveryCarrier } from '../al-inbound-source-validation.ts';

/**
 * A copy of a held message on a carrier its slot does not record yet adds that carrier, so the release answers it
 * there too: the sender handed the message over and holds its receipt on that carrier now.
 */
export function toALInboundCopyCarrierMutations(
    read: ALInboundMessageReadDto,
    toPeerId: string
): readonly ALInboundAdmissionMutation[] {
    const carrier = toALDeliveryCarrier(read.source);
    const slot = read.bufferedSnapshots.find((snapshot) => snapshot.seq === read.msg.ordering?.seq);
    if (slot === undefined || slot.copyCarriers.some((copy) => copy.carrier === carrier)) {
        return [];
    }
    const { ownerRetainUntilMs, ...snapshot } = slot;
    return [{
        kind: 'set-buffered',
        snapshot: { ...snapshot, copyCarriers: [...slot.copyCarriers, { carrier, ackToPeerId: toPeerId }] },
        expireAtTimestamp: Math.min(
            resolveExpireAtTimestampWithFallback(
                resolveALMessageExpireAtMs(slot.msg, slot.plan.effective),
                read.retention.bufferedMessageTtlMs,
                read.nowMs
            ),
            ownerRetainUntilMs
        )
    }];
}

/**
 * The release's `delivered` on every other carrier that brought a copy while the message waited: a sender that handed
 * the message over holds its receipt there, and that copy drew no answer while the message was held.
 */
export function toALInboundCopyCarrierReleaseAcks(
    snapshot: ALInboundOrderedDeliverySnapshot
): readonly ALInboundEffectIntent[] {
    const { msg, plan } = snapshot;
    if (plan.ack.algo === 'none') {
        return [];
    }
    return snapshot.copyCarriers.flatMap((copy) => {
        if (copy.carrier === snapshot.carrier || copy.ackToPeerId === null) {
            return [];
        }
        const ack = toALInboundAckEffect({
            toPeerId: copy.ackToPeerId,
            ackedMsgId: msg.id.msgId,
            originPeerId: msg.id.senderId,
            expireAtTimestamp: resolveALMessageExpireAtMs(msg, plan.effective),
            carrier: copy.carrier,
            status: 'delivered'
        });
        return [{ ...ack, effectId: `${ack.effectId}:${copy.carrier}` }];
    });
}
