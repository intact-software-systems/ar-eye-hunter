import type { ALAckAlgo } from '../../al-contracts/al-policy.ts';
import type { ALOutboundAckTrackingPlan } from './al-outbound-message-runtime.ts';

/**
 * The receipt an admission tracks: the ack tracking its carrier's plan wrote, `none` when it wrote none.
 * The WS client writes none for a `hop` or `subtree` room send, so its handle must not wait for one (R-S3a-4).
 */
export function toALOutboundTrackedReceiptAlgo(ackTracking: ALOutboundAckTrackingPlan | null | undefined): ALAckAlgo {
    return ackTracking?.enabled === true ? ackTracking.mode : 'none';
}
