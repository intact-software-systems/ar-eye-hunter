import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALQosNormalizationResult } from '../../../al-contracts/al-policy.ts';
import { Either } from '../../../resilience/Either.ts';
import type { ALOutboundDispatchPlan } from '../al-outbound-message-runtime.ts';
import { isALOutboundSequencedRoomSend } from './to-al-outbound-minting-plan.ts';

export interface ComputeALOutboundOrderingRefusalInput {
    readonly msg: ALMessage;
    readonly policy: ALQosNormalizationResult;
}

/**
 * A restored checkpoint could send a client sequence position again for different content, so a
 * `local-checkpoint` send that carries a `seq`, or a room send that asks its outbound for one from a head the
 * checkpoint lane cannot keep, is the admission's `unsupported` refusal. Any other ordering key carries no position,
 * and a superseded unsent copy was never seen outside the runtime.
 */
export function computeALOutboundOrderingRefusal<TPrepared>(
    input: ComputeALOutboundOrderingRefusalInput
): Either<ALOutboundDispatchPlan<TPrepared>, ALMessage> {
    const { msg, policy } = input;
    if (policy.effective.durability.algo !== 'local-checkpoint') {
        return Either.ofRight(msg);
    }
    if (msg.ordering?.seq !== undefined) {
        return Either.ofLeft(
            toUnsupportedPlan(msg, `A local-checkpoint send cannot carry sequence ${msg.ordering.seq}`)
        );
    }
    return isALOutboundSequencedRoomSend(msg)
        ? Either.ofLeft(toUnsupportedPlan(
            msg,
            `A local-checkpoint room send cannot ask for a sequence on ordering key ${msg.ordering?.orderingKey}`
        ))
        : Either.ofRight(msg);
}

function toUnsupportedPlan<TPrepared>(msg: ALMessage, dropReason: string): ALOutboundDispatchPlan<TPrepared> {
    return { msg, dropReason, dropReasonCode: 'unsupported', lane: 'volatile', preparedMessages: [] };
}
