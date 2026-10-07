import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALQosNormalizationResult } from '../../../al-contracts/al-policy.ts';
import { validateALAckSupport } from '../../../al-contracts/validate-al-ack-support.ts';
import { Either } from '../../../resilience/Either.ts';
import type { ALDeliveryCarrier } from '../../delivery/al-delivery-lifecycle.ts';
import type { ALOutboundDispatchPlan } from '../al-outbound-message-runtime.ts';

export interface ComputeALOutboundAckRefusalInput {
    readonly msg: ALMessage;
    readonly carrier: ALDeliveryCarrier;
    readonly policy: ALQosNormalizationResult;
}

const LEADER_WITHOUT_GROUP_LEADER_DETAIL =
    'A leader receipt needs the group-leader ack, which alone narrows the audience to the room\'s leader';

/** An ack this carrier cannot track for the message's targets is the admission's `unsupported` refusal (D42). */
export function computeALOutboundAckRefusal<TPrepared>(
    input: ComputeALOutboundAckRefusalInput
): Either<ALOutboundDispatchPlan<TPrepared>, ALMessage> {
    const detail = resolveALOutboundAckRefusalDetail(input);
    return detail === undefined
        ? Either.ofRight(input.msg)
        : Either.ofLeft({
            msg: input.msg,
            dropReason: detail,
            dropReasonCode: 'unsupported',
            lane: 'volatile',
            preparedMessages: []
        });
}

/**
 * A `leader` receipt requested by quality of service alone would expect the whole audience the send names, so it is
 * refused: only the `group-leader` ack narrows a send to its room's leader.
 */
function resolveALOutboundAckRefusalDetail(
    { msg, carrier, policy }: ComputeALOutboundAckRefusalInput
): string | undefined {
    if (policy.effective.ack.algo === 'leader' && msg.delivery?.ack !== 'group-leader') {
        return LEADER_WITHOUT_GROUP_LEADER_DETAIL;
    }
    const [issue] = validateALAckSupport({
        algo: policy.effective.ack.algo,
        carrier,
        targets: msg.targets,
        capabilities: policy.capabilities
    });
    return issue?.detail;
}
