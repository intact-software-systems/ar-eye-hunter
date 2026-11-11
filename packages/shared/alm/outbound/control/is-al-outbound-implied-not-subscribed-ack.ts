import { isALHopCompletionAck, type ALAckPayload } from '../../../al-contracts/al-control.ts';
import type { ALAckAlgo } from '../../../al-contracts/al-policy.ts';
import { isALLogicalReceiptMode } from '../../../al-contracts/validate-al-ack-support.ts';
import { isALImpliedNotSubscribedNack } from '../../delivery/is-al-implied-not-subscribed-nack.ts';

/**
 * Whether the receipt reads this ACK as its recipient's `not-subscribed` NACK. A relay forwards a recipient's hop-end
 * only under a logical receipt, whose counted recipients sign their own; under `hop` and `subtree` only a hop's own
 * hop-end stands for its NACK, so one hop cannot move another outside.
 */
export function isALOutboundImpliedNotSubscribedAck(
    mode: ALAckAlgo,
    ack: ALAckPayload,
    owedRecipientPeerIds: readonly string[]
): boolean {
    return (isALLogicalReceiptMode(mode) || isALHopCompletionAck(ack)) &&
        isALImpliedNotSubscribedNack(ack, owedRecipientPeerIds);
}
