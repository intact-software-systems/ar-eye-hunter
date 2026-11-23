import type { ALNackPayload } from '../../../al-contracts/al-control.ts';
import type { ALOutboundPendingAckSnapshot } from '../../../alm/al-runtime-state-stores.ts';
import { isALOutsideAudienceNackReason } from '../../../alm/delivery/is-al-outside-audience-nack-reason.ts';
import type { ALReceiptRecord } from '../../../alm/receipt-record/al-receipt-record.ts';
import type { ALReceiptRecordConfirmationDto } from '../../../alm/receipt-record/validate-al-receipt-record-confirmation.ts';

/** A recipient's NACK that places it outside the audience of a publication of the server's own. */
export function isWsQueueBoxServerOwnOutsideAudienceNack(nack: ALNackPayload, serverPeerId: string): boolean {
    return nack.originPeerId === serverPeerId && nack.toPeerId === serverPeerId &&
        isALOutsideAudienceNackReason(nack.reason);
}

/** The record's `outside` confirmation of the recipient an outside-audience NACK names. */
export function toWsQueueBoxServerOutsideAudienceConfirmation(nack: ALNackPayload): ALReceiptRecordConfirmationDto {
    return {
        originPeerId: nack.originPeerId,
        msgId: nack.msgId,
        recipientPeerId: nack.logicalRecipientPeerId,
        kind: 'outside'
    };
}

/**
 * The `outside` confirmations a server publication's pending row proves and its open head has not counted: each
 * expected recipient the row places outside, by an outside-audience NACK it admitted, that the tally does not name.
 */
export function toWsQueueBoxServerUnrecordedOutsideConfirmations(
    view: ALReceiptRecord.View,
    pending: ALOutboundPendingAckSnapshot | undefined
): readonly ALReceiptRecordConfirmationDto[] {
    const { opening } = view.head;
    const { confirmedRecipientPeerIds, outsideAudienceRecipientPeerIds } = view.tally;
    const counted = new Set([...confirmedRecipientPeerIds, ...outsideAudienceRecipientPeerIds]);
    return (pending?.outsideAudiencePeerIds ?? [])
        .filter((peerId) => opening.expectedRecipientPeerIds.includes(peerId) && !counted.has(peerId))
        .map((recipientPeerId) => ({
            originPeerId: opening.originPeerId,
            msgId: opening.msgId,
            recipientPeerId,
            kind: 'outside'
        }));
}
