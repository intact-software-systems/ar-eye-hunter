import { isALControlTypeId } from '../../../al-contracts/al-control-type-ids.ts';
import type { ALVolatileSessionBudget } from '../../volatile-budget/al-volatile-session-budget.ts';
import { toALVolatileSessionAdmission } from '../../volatile-budget/to-al-volatile-session-admission.ts';
import type { ALOutboundDispatchPlan } from '../al-outbound-message-runtime.ts';

export interface AdmitALOutboundVolatileBudgetInput<TPrepared> {
    /** The plan of a message this owner planned itself: a relay forward or a retransmission never reaches here. */
    readonly plan: ALOutboundDispatchPlan<TPrepared>;
    readonly budget: ALVolatileSessionBudget | undefined;
    readonly nowMs: number;
}

/**
 * The plan a volatile data admission this session originates commits under the session's bound (D74). The
 * planned envelope is counted, so its effective QoS expiry sets the release. A control, a plan that already
 * drops, and a message whose sender named no deadline are not counted; one past the bound is dropped with the
 * code `capacity`, which ends its handle `rejected` and is never a fallback trigger (D78, C1).
 */
export function admitALOutboundVolatileBudget<TPrepared>(
    input: AdmitALOutboundVolatileBudgetInput<TPrepared>
): ALOutboundDispatchPlan<TPrepared> {
    const { plan, budget } = input;
    if (
        budget === undefined || plan.dropReason !== undefined ||
        plan.dropReasonCode !== undefined ||
        isALControlTypeId(plan.msg.payload.typeId)
    ) {
        return plan;
    }
    const admission = toALVolatileSessionAdmission(plan.msg, input.nowMs);
    const admitted = admission === undefined ? undefined : budget.tryAdmit(admission);
    return admitted?.left === undefined ? plan : toCapacityRefusedPlan(plan, admitted.left);
}

function toCapacityRefusedPlan<TPrepared>(
    plan: ALOutboundDispatchPlan<TPrepared>,
    refusal: ALVolatileSessionBudget.Refusal
): ALOutboundDispatchPlan<TPrepared> {
    const { usage, limits } = refusal;
    return {
        ...plan,
        dropReason: `The session's volatile bound is full (${refusal.limit}): ${usage.admissions} of ` +
            `${limits.maxAdmissions} admissions, ${usage.bytes} of ${limits.maxBytes} bytes.`,
        dropReasonCode: 'capacity',
        preparedMessages: []
    };
}
