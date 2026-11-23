import type { ALNackPayload } from '../../../al-contracts/al-control.ts';
import { isALOutsideAudienceNackReason } from '../../../alm/delivery/is-al-outside-audience-nack-reason.ts';
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
