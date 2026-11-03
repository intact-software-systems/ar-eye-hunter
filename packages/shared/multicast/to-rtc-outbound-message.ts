import type { ALMessage } from '../al-contracts/al-contract.ts';
import type { ALQosEffectivePolicy } from '../al-contracts/al-policy.ts';
import { toALOutboundMessage } from '../alm/outbound/to-al-outbound-message.ts';

/**
 * The RTC planners' outbound message. A message carrying a publication proof was normalized by its origin before it
 * was signed, so an origin re-plan and a relay's forward return it as it is: every signed field stays byte-identical.
 */
export function toRtcOutboundMessage(msg: ALMessage, effective: ALQosEffectivePolicy): ALMessage {
    return msg.proof === undefined ? toALOutboundMessage(msg, effective) : msg;
}
