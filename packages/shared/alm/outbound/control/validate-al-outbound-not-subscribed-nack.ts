import type { ALNackPayload } from '../../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../../al-contracts/al-message-persistence-validation.ts';
import type { ALControlAdmissionRead } from '../compute-al-outbound-control-admission.ts';
import { toALOutboundReceiptClasses } from './to-al-outbound-receipt-classes.ts';

/**
 * A `not-subscribed` NACK speaks for its logical recipient, as an ACK does, whichever hop relayed it: it moves a
 * recipient the receipt still owes outside the audience, and is refused for anyone else (PL9, PL16).
 */
export function validateALOutboundNotSubscribedNack(
    read: ALControlAdmissionRead,
    nack: ALNackPayload
): readonly ALMessageRejection[] {
    const recipientPeerId = nack.logicalRecipientPeerId;
    const owed = read.pending !== undefined &&
        toALOutboundReceiptClasses(read.pending).unconfirmedPeerIds.includes(recipientPeerId);
    return [
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
