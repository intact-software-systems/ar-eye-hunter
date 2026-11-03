import type { ALMessage } from '../al-contracts/al-contract.ts';
import type { ALQosEffectivePolicy } from '../al-contracts/al-policy.ts';
import type { ALOutboundDispatchPlan } from '../alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '../alm/outbound/al-outbound-transport-message.ts';
import { Either } from '../resilience/Either.ts';

/**
 * No server stands on the RTC path to arbitrate two claimants of one resource, so an exclusive send is refused as
 * unsupported: the refusal a fallback carrier takes over, named with the targets its sender gave, and the verdict of
 * an RTC-only send.
 */
export function computeRtcExclusiveRefusal(
    msg: ALMessage,
    original: ALMessage,
    effective: ALQosEffectivePolicy
): Either<ALOutboundDispatchPlan<ALOutboundTransportMessage>, ALMessage> {
    return effective.ownership.algo !== 'exclusive'
        ? Either.ofRight(msg)
        : Either.ofLeft({
            msg: { ...msg, targets: original.targets },
            dropReason: 'RTC cannot arbitrate an exclusive claim: an exclusive send is unsupported',
            dropReasonCode: 'unsupported',
            lane: 'volatile',
            preparedMessages: []
        });
}
