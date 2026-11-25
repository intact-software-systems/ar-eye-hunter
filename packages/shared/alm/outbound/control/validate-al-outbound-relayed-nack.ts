import type { ALNackPayload } from '../../../al-contracts/al-control.ts';
import { isALReceiptModeOwnWord } from '../../delivery/is-al-receipt-mode-own-word.ts';
import type { ALControlAdmissionRead } from '../compute-al-outbound-control-admission.ts';
import {
    isALOutboundRecipientControlSender,
    isALOutboundUnreceiptedRepairRecipient
} from './is-al-outbound-expected-repair-peer.ts';
import { toALOutboundRefusalIssue, type ALOutboundControlIssue } from './read-al-outbound-recipient-proof.ts';
import { toALOutboundReceiptClasses } from './to-al-outbound-receipt-classes.ts';

/**
 * A NACK that speaks for its logical recipient: it comes from a peer a repair may come from, or from a next hop of the
 * message, the relay that re-sends a recipient's NACK, and names a recipient the receipt still owes (PL9, PL16,
 * S4ii-R3). A next hop is known only from a receipted send's tracking. A send that tracks no receipt has no receipt to
 * owe and no next hop to know: its relay is the requester the repair authority planned a repair to, and the NACK names
 * a recipient the send may be repaired for (6c). A room send's gap NACK may also come from a relay the message never
 * went through, a new parent after a reshape: the repair authority planned a repair to it, and the receipt still owes
 * its recipient (6d). Under `hop` and `subtree` only the recipient's own NACK speaks for it, so one hop cannot speak
 * for another.
 */
export function validateALOutboundRelayedNack(
    read: ALControlAdmissionRead,
    nack: ALNackPayload
): readonly ALOutboundControlIssue[] {
    const unreceipted = read.unreceiptedRepairAudience !== undefined;
    const owed = unreceipted
        ? isALOutboundUnreceiptedRepairRecipient(read, nack.logicalRecipientPeerId)
        : read.pending !== undefined &&
            toALOutboundReceiptClasses(read.pending).unconfirmedPeerIds.includes(nack.logicalRecipientPeerId);
    const fromExpectedPeer = unreceipted || read.isRoomRepairedRelayedGapNack ||
        isALOutboundRecipientControlSender(read, nack.fromPeerId);
    const ownWord = read.pending === undefined || isALReceiptModeOwnWord(read.pending.mode, nack);
    return [
        ...(fromExpectedPeer
            ? []
            : [toALOutboundRefusalIssue(`AL ${nack.reason} NACK comes from no hop or recipient of this message`)]),
        ...(owed
            ? []
            : [toALOutboundRefusalIssue(
                unreceipted
                    ? `AL ${nack.reason} NACK names no recipient of the frozen audience`
                    : `AL ${nack.reason} NACK names no recipient the receipt still owes`
            )]),
        ...(ownWord
            ? []
            : [toALOutboundRefusalIssue(`AL ${nack.reason} NACK speaks for another recipient under a hop receipt`)])
    ];
}
