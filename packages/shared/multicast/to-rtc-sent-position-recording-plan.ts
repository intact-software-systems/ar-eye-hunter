import { resolveALFrozenMulticastAudience } from '../al-contracts/al-frozen-multicast-audience.ts';
import type { ALOutboundDispatchPlan } from '../alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '../alm/outbound/al-outbound-transport-message.ts';

/**
 * The origin finalizes its own frozen audience, so a plan that owns its track (`toALOutboundMintingPlan`: the origin's
 * own keyed room send at its first admission) records the sent position of every frozen recipient, granted topic or
 * not (S4-R1, S4-R10); any other plan records nothing.
 */
export function toRtcSentPositionRecordingPlan(
    plan: ALOutboundDispatchPlan<ALOutboundTransportMessage>
): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
    const frozen = resolveALFrozenMulticastAudience(plan.msg.targets);
    return frozen === undefined || plan.mintsSequence !== true
        ? plan
        : { ...plan, recordsSentPositions: frozen.recipientPeerIds };
}
