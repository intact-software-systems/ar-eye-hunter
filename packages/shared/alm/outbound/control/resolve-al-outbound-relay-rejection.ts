import type { ALNackReason } from '../../../al-contracts/al-control.ts';
import type { ALDeliveryRelayRejection } from '../../delivery/al-delivery-lifecycle.ts';
import type { ALOutboundSettlementFact } from '../al-outbound-message-runtime.ts';
import type { ALControlAdmissionRead } from '../compute-al-outbound-control-admission.ts';

/**
 * A NACK that refuses the whole send rather than one receipt: a relay's `resync-required` whatever the receipt,
 * and before any receipt row exists a `membership-fenced` refusal or the trusted server's `unauthorized`,
 * `no-leader` or `held-by-other` one.
 * Only the trusted server speaks without being a peer the send owes, so only its rejection waives that check.
 */
export function resolveALOutboundRelayRejection(read: ALControlAdmissionRead): ALDeliveryRelayRejection | undefined {
    if (read.parsed.type !== 'nack') {
        return undefined;
    }
    const nack = read.parsed.payload;
    const beforeReceipt = read.sent !== undefined && read.pending === undefined;
    if (read.source === 'trusted-server') {
        return nack.reason === 'resync-required' ||
                (beforeReceipt && isTrustedServerAdmissionRefusal(nack.reason))
            ? { relay: 'trusted-server', reason: nack.reason }
            : undefined;
    }
    return nack.reason === 'resync-required' || (beforeReceipt && nack.reason === 'membership-fenced')
        ? { relay: 'peer', peerId: nack.fromPeerId, reason: nack.reason }
        : undefined;
}

function isTrustedServerAdmissionRefusal(
    reason: ALNackReason
): reason is 'unauthorized' | 'membership-fenced' | 'no-leader' | 'held-by-other' {
    return reason === 'unauthorized' || reason === 'membership-fenced' || reason === 'no-leader' ||
        reason === 'held-by-other';
}

export function toALOutboundRelayRejectedFact(
    msgId: string,
    relayRejection: ALDeliveryRelayRejection
): ALOutboundSettlementFact {
    const relay = relayRejection.relay === 'trusted-server' ? 'The server relay' : `Hop ${relayRejection.peerId}`;
    return {
        kind: 'relay-rejected',
        msgId,
        relayRejection,
        detail: `${relay} refused the message: ${relayRejection.reason}.`
    };
}
