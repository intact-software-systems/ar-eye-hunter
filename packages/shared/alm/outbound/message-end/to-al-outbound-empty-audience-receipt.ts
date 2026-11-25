import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { resolveALFrozenMulticastAudience } from '../../../al-contracts/al-frozen-multicast-audience.ts';
import type { ALOutboundDispatchPlan, ALOutboundSettlementFact } from '../al-outbound-message-runtime.ts';
import { toALOutboundAcknowledgementFact } from '../transition-al-outbound-pending-ack.ts';

/**
 * A `receiver` multicast frozen to an empty audience has nobody left to confirm it: its receipt is
 * complete with no row, as the WS server answers an empty audience.
 */
export function isALOutboundEmptyAudienceReceipt<TPrepared>(plan: ALOutboundDispatchPlan<TPrepared>): boolean {
    return plan.ackTracking?.mode === 'receiver' &&
        resolveALFrozenMulticastAudience(plan.msg.targets)?.recipientPeerIds.length === 0;
}

/** The acknowledgement of a receipt an empty frozen audience completed: nobody expected, nobody confirmed. */
export function toALOutboundEmptyAudienceReceipt(msg: ALMessage): ALOutboundSettlementFact {
    return toALOutboundAcknowledgementFact({
        receipt: {
            msgId: msg.id.msgId,
            mode: 'receiver',
            expectedPeerIds: [],
            ackedPeerIds: [],
            outsideAudiencePeerIds: []
        },
        hops: { nextHopPeerIds: [], completedHopPeerIds: [] },
        complete: true,
        traceId: msg.id.traceId
    });
}
