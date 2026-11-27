import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { resolveALMessageExpireAtMs } from '../../../al-contracts/al-policy.ts';
import { isALLogicalReceiptMode } from '../../../al-contracts/validate-al-ack-support.ts';
import type { ALOutboundPendingAckSnapshot } from '../../../alm/al-runtime-state-stores.ts';
import type { ALReceiptRecordOpening } from '../../../alm/receipt-record/al-receipt-record-rows.ts';
import { AL_RECEIPT_RECORD_WINDOW_MS } from '../../../alm/receipt-record/validate-al-receipt-record-opening.ts';

/** A logically receipted publication of the server's own, as its pending receipt row and its sent row hold it. */
export interface WsQueueBoxServerOwnPendingReceipt {
    readonly message: ALMessage;
    readonly pending: ALOutboundPendingAckSnapshot;
}

export interface WsQueueBoxServerOwnReceiptOpeningInput extends WsQueueBoxServerOwnPendingReceipt {
    readonly serverPeerId: string;
    readonly nowMs: number;
}

/**
 * The head of a server publication: the recipients its pending receipt row expects, and a deadline half an ACK
 * window before what is left of that row's retransmission budget, so the record's terminal receipt ends the row
 * before the row's timer can. Undefined for a message another peer sent, a row that is not a logical receipt, or one
 * that expects nobody.
 */
export function toWsQueueBoxServerOwnReceiptOpening(
    input: WsQueueBoxServerOwnReceiptOpeningInput
): ALReceiptRecordOpening | undefined {
    const { message, pending, serverPeerId, nowMs } = input;
    if (
        message.id.senderId !== serverPeerId || !isALLogicalReceiptMode(pending.mode) ||
        pending.expectedPeerIds.length === 0
    ) {
        return undefined;
    }
    const budgetEndAtMs = pending.deadlineAtMs + pending.timeoutMs * (pending.maxAttempts - pending.attempts);
    return {
        originPeerId: serverPeerId,
        msgId: message.id.msgId,
        traceId: message.id.traceId,
        expectedRecipientPeerIds: pending.expectedPeerIds,
        neverSentRecipientPeerIds: [],
        snapshotVersion: 0,
        deadlineAtMs: Math.min(
            budgetEndAtMs - Math.floor(pending.timeoutMs / 2),
            resolveALMessageExpireAtMs(message) ?? Number.POSITIVE_INFINITY,
            nowMs + AL_RECEIPT_RECORD_WINDOW_MS
        )
    };
}
