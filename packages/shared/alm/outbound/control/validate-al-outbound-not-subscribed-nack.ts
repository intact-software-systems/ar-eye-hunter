import type { ALNackPayload } from '../../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../../al-contracts/al-message-persistence-validation.ts';
import type { ALControlAdmissionRead } from '../compute-al-outbound-control-admission.ts';
import { isALOutboundExpectedRepairPeer } from './is-al-outbound-expected-repair-peer.ts';
import { toALOutboundReceiptClasses } from './to-al-outbound-receipt-classes.ts';

/**
 * A `not-subscribed` NACK speaks for its logical recipient, as an ACK does, whichever hop relayed it: it moves a
 * recipient the receipt still owes outside the audience, and is refused for anyone else (PL9, PL16). It comes from
 * a peer a repair may come from, or from a next hop of the message, the relay that re-sends a recipient's NACK.
 */
export function validateALOutboundNotSubscribedNack(
    read: ALControlAdmissionRead,
    nack: ALNackPayload
): readonly ALMessageRejection[] {
    const recipientPeerId = nack.logicalRecipientPeerId;
    const owed = read.pending !== undefined &&
        toALOutboundReceiptClasses(read.pending).unconfirmedPeerIds.includes(recipientPeerId);
    const fromExpectedPeer = isALOutboundExpectedRepairPeer(read, nack.fromPeerId) ||
        read.sent?.policy.ackTracking?.nextHopPeerIds.includes(nack.fromPeerId) === true;
    return [
        ...(fromExpectedPeer
            ? []
            : [{
                code: 'unauthorized' as const,
                message: 'AL not-subscribed NACK comes from no hop or recipient of this message'
            }]),
        ...(owed
            ? []
            : [{
                code: 'unauthorized' as const,
                message: 'AL not-subscribed NACK names no recipient the receipt still owes'
            }]),
        ...(read.sent !== undefined && read.sent.reference.expiresAtMs <= read.nowMs
            ? [{ code: 'unauthorized' as const, message: 'AL not-subscribed NACK arrived after its message deadline' }]
            : [])
    ];
}
