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

/** An ack this carrier cannot track for the message's targets is the admission's `unsupported` refusal (D42). */
export function computeALOutboundAckRefusal<TPrepared>(
    input: ComputeALOutboundAckRefusalInput
): Either<ALOutboundDispatchPlan<TPrepared>, ALMessage> {
    const { msg, carrier, policy } = input;
    const [issue] = validateALAckSupport({
        algo: policy.effective.ack.algo,
        carrier,
        targets: msg.targets,
        capabilities: policy.capabilities
    });
    return issue === undefined
        ? Either.ofRight(msg)
        : Either.ofLeft({
            msg,
            dropReason: issue.detail,
            dropReasonCode: 'unsupported',
            persist: false,
            preparedMessages: []
        });
}
