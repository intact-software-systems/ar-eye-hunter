import type { ALOutboundMessageReadDto } from '../admission/al-outbound-admission-store.ts';
import type { ALOutboundSettlementFact } from '../al-outbound-message-runtime.ts';
import {
    isALOutboundAckTrackingWritable,
    isALOutboundReceiptComplete,
    toALOutboundAcknowledgementFact,
    toALOutboundCompletedHopPeerIds,
    toALOutboundTrackedReceipt
} from '../transition-al-outbound-pending-ack.ts';

/** What one dispatch read holds about the receipt its plan may complete. */
export type ALOutboundDispatchCompletionRead<TPrepared> = Pick<
    ALOutboundMessageReadDto<TPrepared>,
    'msg' | 'plan' | 'pendingAck' | 'acks' | 'nowMs'
>;

/**
 * The acknowledgement a re-plan states when its tracking completes the receipt row the dispatch then
 * deletes -- an RTC `replace` retry drops a peer that left, under `hop` and `receiver` alike -- so that
 * receipt end settles instead of vanishing.
 */
export function toALOutboundDispatchCompletionReceipt<TPrepared>(
    read: ALOutboundDispatchCompletionRead<TPrepared>
): ALOutboundSettlementFact | undefined {
    const tracking = read.plan.ackTracking;
    if (
        read.pendingAck === undefined || tracking === undefined ||
        !isALOutboundAckTrackingWritable(tracking)
    ) {
        return undefined;
    }
    const receipt = toALOutboundTrackedReceipt({
        msgId: read.msg.id.msgId,
        current: read.pendingAck,
        acks: read.acks,
        tracking,
        nowMs: read.nowMs
    });
    if (!isALOutboundReceiptComplete(receipt)) {
        return undefined;
    }
    return toALOutboundAcknowledgementFact({
        receipt,
        hops: {
            nextHopPeerIds: tracking.nextHopPeerIds,
            completedHopPeerIds: toALOutboundCompletedHopPeerIds(read.acks)
        },
        complete: true
    });
}
