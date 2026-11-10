import type { ALNackPayload } from '../../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../../al-contracts/al-message-persistence-validation.ts';
import type { ALControlAdmissionRead } from '../compute-al-outbound-control-admission.ts';
import { isALOutboundRecipientControlSender } from './is-al-outbound-expected-repair-peer.ts';
import { toALOutboundReceiptClasses } from './to-al-outbound-receipt-classes.ts';

/**
 * A NACK that speaks for its logical recipient, whichever hop relayed it: it comes from a peer a repair may come from,
 * or from a next hop of the message, the relay that re-sends a recipient's NACK, and names a recipient the receipt
 * still owes (PL9, PL16, S4ii-R3). A next hop is known only from a receipted send's tracking.
 */
export function validateALOutboundRelayedNack(
    read: ALControlAdmissionRead,
    nack: ALNackPayload
): readonly ALMessageRejection[] {
    const owed = read.pending !== undefined &&
        toALOutboundReceiptClasses(read.pending).unconfirmedPeerIds.includes(nack.logicalRecipientPeerId);
    const fromExpectedPeer = isALOutboundRecipientControlSender(read, nack.fromPeerId);
    return [
        ...(fromExpectedPeer
            ? []
            : [{
                code: 'unauthorized' as const,
                message: `AL ${nack.reason} NACK comes from no hop or recipient of this message`
            }]),
        ...(owed
            ? []
            : [{
                code: 'unauthorized' as const,
                message: `AL ${nack.reason} NACK names no recipient the receipt still owes`
            }])
    ];
}
