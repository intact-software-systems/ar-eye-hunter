import { isOrderedSendReceiptExpected } from './compute-ordered-send-receipt-figures.ts';
import type { OrderedSendCellObservations } from './ordered-send-cell-observations.ts';
import { toOrderedSendByMsgId } from './to-observed-ordered-sends.ts';

/**
 * What the cell recorded that no other figure of the report counts. Each count is over one whole list of the
 * observations, and a run that recorded only what it sent leaves every one at 0.
 */
export interface OrderedSendUnmatchedFigures {
    /** Sends whose msgId an earlier send in the list already carries. */
    readonly sendsWithARepeatedMsgId: number;
    /** Arrivals whose msgId no send carries. */
    readonly arrivalsOfUnknownMessage: number;
    /** Arrivals of a known send at a recipient that send did not expect. */
    readonly arrivalsAtUnexpectedRecipient: number;
    /** Hand-offs whose msgId no send carries. */
    readonly handOffsOfUnknownMessage: number;
    /** Receipts whose msgId no send carries. */
    readonly receiptsOfUnknownMessage: number;
    /** Receipts of a known send the entry did not answer `admitted` or `pending-admission`. */
    readonly receiptsOfASendNotAccepted: number;
    /** NACKs and repair requests whose msgId no send carries. */
    readonly controlsOfUnknownMessage: number;
    /** Control frames that are no receipt, no NACK and no repair request. */
    readonly unclassifiedControls: number;
    /** Later offers whose msgId no send carries. */
    readonly resendsOfUnknownMessage: number;
}

export function computeOrderedSendUnmatchedFigures(
    observations: OrderedSendCellObservations
): OrderedSendUnmatchedFigures {
    const sendByMsgId = toOrderedSendByMsgId(observations.sends);
    return {
        sendsWithARepeatedMsgId: observations.sends.length - sendByMsgId.size,
        arrivalsOfUnknownMessage: observations.arrivals.filter(({ msgId }) => !sendByMsgId.has(msgId)).length,
        arrivalsAtUnexpectedRecipient: observations.arrivals.filter(({ msgId, recipientPeerId }) => {
            const send = sendByMsgId.get(msgId);
            return send !== undefined && !send.expectedRecipientPeerIds.includes(recipientPeerId);
        }).length,
        handOffsOfUnknownMessage: observations.handOffs.filter(({ msgId }) => !sendByMsgId.has(msgId)).length,
        receiptsOfUnknownMessage: observations.receipts.filter(({ msgId }) => !sendByMsgId.has(msgId)).length,
        receiptsOfASendNotAccepted: observations.receipts.filter(({ msgId }) => {
            const send = sendByMsgId.get(msgId);
            return send !== undefined && !isOrderedSendReceiptExpected(send);
        }).length,
        controlsOfUnknownMessage: observations.controls.filter(({ msgId }) => !sendByMsgId.has(msgId)).length,
        unclassifiedControls: observations.unclassifiedControls.length,
        resendsOfUnknownMessage: observations.resends.filter(({ msgId }) => !sendByMsgId.has(msgId)).length
    };
}
