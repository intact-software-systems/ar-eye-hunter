import type { ALNackReason } from '../../../al-contracts/al-control.ts';
import type { ALDeliveryRelayRejection } from '../../delivery/al-delivery-lifecycle.ts';
import type { ALOutboundSettlementFact } from '../al-outbound-message-runtime.ts';
import type { ALControlAdmissionRead } from '../compute-al-outbound-control-admission.ts';

/**
 * A NACK that refuses the whole send rather than one receipt: a relay's `resync-required` and the trusted
 * server's `held-by-other`, `unsupported` or `no-publish-grant` whatever the receipt (`route` re-reads the grant after
 * the admitted receipt), and before any receipt row exists a `membership-fenced`
 * refusal or the trusted server's `unauthorized` or `no-leader` one. A claim the server retained on a
 * conflict may already have its `admitted` receipt when the replay drops it (D175).
 * Only the trusted server speaks without being a peer the send owes, so only its rejection waives that check.
 */
export function resolveALOutboundRelayRejection(read: ALControlAdmissionRead): ALDeliveryRelayRejection | undefined {
    if (read.parsed.type !== 'nack') {
        return undefined;
    }
    const nack = read.parsed.payload;
    const beforeReceipt = read.sent !== undefined && read.pending === undefined;
    if (read.source === 'trusted-server') {
        return isTrustedServerSendRefusal(nack.reason) ||
                (beforeReceipt && isTrustedServerAdmissionRefusal(nack.reason))
            ? { relay: 'trusted-server', reason: nack.reason }
            : undefined;
    }
    return nack.reason === 'resync-required' || (beforeReceipt && nack.reason === 'membership-fenced')
        ? { relay: 'peer', peerId: nack.fromPeerId, reason: nack.reason }
        : undefined;
}

function isTrustedServerSendRefusal(
    reason: ALNackReason
): reason is 'resync-required' | 'held-by-other' | 'unsupported' | 'no-publish-grant' {
    return reason === 'resync-required' || reason === 'held-by-other' || reason === 'unsupported' ||
        reason === 'no-publish-grant';
}

function isTrustedServerAdmissionRefusal(
    reason: ALNackReason
): reason is 'unauthorized' | 'membership-fenced' | 'no-leader' {
    return reason === 'unauthorized' || reason === 'membership-fenced' || reason === 'no-leader';
}

export function toALOutboundRelayRejectedFact(
    msgId: string,
    traceId: string,
    relayRejection: ALDeliveryRelayRejection
): ALOutboundSettlementFact {
    const relay = relayRejection.relay === 'trusted-server' ? 'The server relay' : `Hop ${relayRejection.peerId}`;
    return {
        kind: 'relay-rejected',
        msgId,
        traceId,
        relayRejection,
        detail: `${relay} refused the message: ${relayRejection.reason}.`
    };
}
