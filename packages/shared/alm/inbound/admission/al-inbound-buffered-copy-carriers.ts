import { resolveALMessageExpireAtMs } from '../../../al-contracts/al-policy.ts';
import { resolveExpireAtTimestampWithFallback } from '../../ALStoreRetention.ts';
import type { ALInboundAdmissionMutation, ALInboundMessageReadDto } from '../al-inbound-admission-store.ts';
import { toALInboundAckEffect, type ALInboundEffectIntent } from '../al-inbound-effect-intent.ts';
import type { ALInboundOrderedDeliverySnapshot } from '../al-inbound-ordering-validation.ts';
import { toALDeliveryCarrier } from '../al-inbound-source-validation.ts';

/** The copy an arrival brought: the peer it acknowledges to, and the instant the slot may not outlive. */
export interface ALInboundRecordedCopy {
    readonly ackToPeerId: string | null;
    readonly retainUntilMs: number;
}

/**
 * The slot write that records the copy `read` brought on `slot`: its carrier and acknowledging peer appended, kept
 * while the message is, never past the copy's `retainUntilMs`. The first copy records the slot's own carrier.
 */
export function toALInboundRecordedCopyMutation(
    read: Pick<ALInboundMessageReadDto, 'source' | 'retention' | 'nowMs'>,
    slot: ALInboundOrderedDeliverySnapshot,
    copy: ALInboundRecordedCopy
): ALInboundAdmissionMutation {
    const recorded = { carrier: toALDeliveryCarrier(read.source), ackToPeerId: copy.ackToPeerId };
    return {
        kind: 'set-buffered',
        snapshot: { ...slot, copyCarriers: [...slot.copyCarriers, recorded] },
        expireAtTimestamp: Math.min(
            resolveExpireAtTimestampWithFallback(
                resolveALMessageExpireAtMs(slot.msg, slot.plan.effective),
                read.retention.bufferedMessageTtlMs,
                read.nowMs
            ),
            copy.retainUntilMs
        )
    };
}

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
    return [
        toALInboundRecordedCopyMutation(read, snapshot, { ackToPeerId: toPeerId, retainUntilMs: ownerRetainUntilMs })
    ];
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
