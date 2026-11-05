import { resolveALFrozenMulticastAudience } from '../al-contracts/al-frozen-multicast-audience.ts';
import { toALOrderingTrackKey, toALSequenceMintTrackKey } from '../al-contracts/al-runtime.ts';
import type { ALOutboundDispatchPlan } from '../alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '../alm/outbound/al-outbound-transport-message.ts';

/**
 * The origin finalizes its own frozen audience, so the plan of a frame's first admission on a track records the sent
 * position of every frozen recipient, granted topic or not (S4-R1, S4-R10); any other plan records nothing.
 */
export function toRtcSentPositionRecordingPlan(
    plan: ALOutboundDispatchPlan<ALOutboundTransportMessage>,
    selfPeerId: string
): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
    const frozen = resolveALFrozenMulticastAudience(plan.msg.targets);
    const tracked = (toALOrderingTrackKey(plan.msg) ?? toALSequenceMintTrackKey(plan.msg)) !== undefined;
    return frozen === undefined || !tracked || plan.msg.id.senderId !== selfPeerId || plan.dropReasonCode !== undefined
        ? plan
        : { ...plan, recordsSentPositions: frozen.recipientPeerIds };
}
