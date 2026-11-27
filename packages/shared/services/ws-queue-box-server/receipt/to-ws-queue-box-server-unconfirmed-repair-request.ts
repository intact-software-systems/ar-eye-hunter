import type { ALOutboundRepairRequest } from '../../../alm/outbound/al-outbound-message-runtime.ts';
import type { ALReceiptRecord } from '../../../alm/receipt-record/al-receipt-record.ts';

/**
 * A receipt retry asks only for the recipients its record has not confirmed or placed outside; one whose receipt has
 * ended, or whose deadline has passed, asks for nothing. Any other repair, and a message with no record, is unchanged.
 */
export function toWsQueueBoxServerUnconfirmedRepairRequest(
    request: ALOutboundRepairRequest,
    view: ALReceiptRecord.View | undefined,
    nowMs: number
): ALOutboundRepairRequest | undefined {
    if (request.trigger !== 'ack-timeout' || view === undefined) {
        return request;
    }
    const { head, tally } = view;
    if (head.phase !== 'open' || head.opening.deadlineAtMs <= nowMs) {
        return undefined;
    }
    const answered = new Set([...tally.confirmedRecipientPeerIds, ...tally.outsideAudienceRecipientPeerIds]);
    return { ...request, failedPeerIds: request.failedPeerIds.filter((peerId) => !answered.has(peerId)) };
}
