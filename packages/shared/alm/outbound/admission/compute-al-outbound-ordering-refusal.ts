import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALQosNormalizationResult } from '../../../al-contracts/al-policy.ts';
import { Either } from '../../../resilience/Either.ts';
import type { ALOutboundDispatchPlan } from '../al-outbound-message-runtime.ts';

export interface ComputeALOutboundOrderingRefusalInput {
    readonly msg: ALMessage;
    readonly policy: ALQosNormalizationResult;
}

/**
 * A restored checkpoint could send a client sequence position again for different content, so a
 * `local-checkpoint` send that carries a `seq` is the admission's `unsupported` refusal. An ordering key
 * alone carries no position, and a superseded unsent copy was never seen outside the runtime.
 */
export function computeALOutboundOrderingRefusal<TPrepared>(
    input: ComputeALOutboundOrderingRefusalInput
): Either<ALOutboundDispatchPlan<TPrepared>, ALMessage> {
    const { msg, policy } = input;
    return policy.effective.durability.algo !== 'local-checkpoint' || msg.ordering?.seq === undefined
        ? Either.ofRight(msg)
        : Either.ofLeft({
            msg,
            dropReason: `A local-checkpoint send cannot carry sequence ${msg.ordering.seq}`,
            dropReasonCode: 'unsupported',
            lane: 'volatile',
            preparedMessages: []
        });
}
