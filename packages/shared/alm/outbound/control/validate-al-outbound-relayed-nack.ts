import type { ALNackPayload } from '../../../al-contracts/al-control.ts';
import { isALReceiptModeOwnWord } from '../../delivery/is-al-receipt-mode-own-word.ts';
import type { ALControlAdmissionRead } from '../compute-al-outbound-control-admission.ts';
import { toALOutboundRefusalIssue, type ALOutboundControlIssue } from '../validate-al-outbound-control-admission.ts';
import { isALOutboundRecipientControlSender } from './is-al-outbound-expected-repair-peer.ts';
import { toALOutboundReceiptClasses } from './to-al-outbound-receipt-classes.ts';

/**
 * A NACK that speaks for its logical recipient: it comes from a peer a repair may come from, or from a next hop of the
 * message, the relay that re-sends a recipient's NACK, and names a recipient the receipt still owes (PL9, PL16,
 * S4ii-R3). A next hop is known only from a receipted send's tracking. Under `hop` and `subtree` only the recipient's
 * own NACK speaks for it, so one hop cannot speak for another.
 */
export function validateALOutboundRelayedNack(
    read: ALControlAdmissionRead,
    nack: ALNackPayload
): readonly ALOutboundControlIssue[] {
    const owed = read.pending !== undefined &&
        toALOutboundReceiptClasses(read.pending).unconfirmedPeerIds.includes(nack.logicalRecipientPeerId);
    const fromExpectedPeer = isALOutboundRecipientControlSender(read, nack.fromPeerId);
    const ownWord = read.pending === undefined || isALReceiptModeOwnWord(read.pending.mode, nack);
    return [
        ...(fromExpectedPeer
            ? []
            : [toALOutboundRefusalIssue(`AL ${nack.reason} NACK comes from no hop or recipient of this message`)]),
        ...(owed
            ? []
            : [toALOutboundRefusalIssue(`AL ${nack.reason} NACK names no recipient the receipt still owes`)]),
        ...(ownWord
            ? []
            : [toALOutboundRefusalIssue(`AL ${nack.reason} NACK speaks for another recipient under a hop receipt`)])
    ];
}
