import { AL_MESSAGE_RESOURCE_LIMITS } from '../../../al-contracts/al-message-resource-limits.ts';
import { Either } from '../../../resilience/Either.ts';
import type { ALOutboundAdmissionMutation } from '../admission/al-outbound-admission-mutations.ts';
import type { ALOutboundMessageReadDto } from '../admission/al-outbound-admission-store.ts';

/** The requester a budgeted repair is charged to, and how many attempts each requester may spend. */
export interface ALOutboundRepairBudget {
    readonly requesterKey: string;
    readonly maxAttempts: number;
}

/** A repair budget a dispatch found spent, as the message's `repair-exhausted` settlement states it. */
export interface ALOutboundRepairExhaustion {
    readonly detail: string;
}

/**
 * The one charge a budgeted repair makes to its requester, or the exhaustion it finds instead. The charge
 * belongs to the attempt's sends: a hint re-executed after a conflict or an expired lease finds them committed
 * and charges nothing more, so a budget is spent once per attempt identity. Each requester has its own budget;
 * a new requester past the row's bound of requesters is refused.
 */
export function computeALOutboundRepairAttemptCharge<TPrepared>(
    read: ALOutboundMessageReadDto<TPrepared>,
    repairBudget: ALOutboundRepairBudget | undefined
): Either<ALOutboundRepairExhaustion, readonly ALOutboundAdmissionMutation[]> {
    if (!repairBudget || read.repairAttemptCommitted) {
        return Either.ofRight([]);
    }
    const { requesterKey, maxAttempts } = repairBudget;
    const msgId = read.msg.id.msgId;
    const attemptsByRequester = read.repairAttempt?.attemptsByRequester ?? {};
    const isKnownRequester = Object.hasOwn(attemptsByRequester, requesterKey);
    const requesterCount = Object.keys(attemptsByRequester).length;
    if (!isKnownRequester && requesterCount >= AL_MESSAGE_RESOURCE_LIMITS.collectionEntries) {
        return Either.ofLeft({
            detail:
                `The repair of ${msgId} is refused to a new requester: ${requesterCount} requesters already hold its budget.`
        });
    }
    // Own-key access only: a requester named like an Object.prototype member must read as a new requester.
    const attempts = isKnownRequester ? attemptsByRequester[requesterKey] ?? 0 : 0;
    if (attempts >= maxAttempts) {
        return Either.ofLeft({
            detail: `The repair of ${msgId} ran out of retransmits after ${attempts} of ${maxAttempts}.`
        });
    }
    return Either.ofRight([{
        kind: 'set-repair-attempt',
        snapshot: { msgId, attemptsByRequester: { ...attemptsByRequester, [requesterKey]: attempts + 1 } }
    }]);
}
