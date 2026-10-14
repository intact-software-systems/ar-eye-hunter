import { isALControlTypeId } from '../../../al-contracts/al-control-type-ids.ts';
import type { ALDeliveryAdmissionVerdict } from '../../delivery/al-delivery-lifecycle.ts';
import {
    AL_VOLATILE_SESSION_OWN_SHARE,
    type ALVolatileSessionBudget,
    type ALVolatileSessionLimit
} from '../../volatile-budget/al-volatile-session-budget.ts';
import { toALVolatileSessionAdmission } from '../../volatile-budget/to-al-volatile-session-admission.ts';
import type { ALOutboundDispatchPlan } from '../al-outbound-message-runtime.ts';

export interface AdmitALOutboundVolatileBudgetInput<TPrepared> {
    readonly plan: ALOutboundDispatchPlan<TPrepared>;
    readonly budget: ALVolatileSessionBudget | undefined;
    readonly nowMs: number;
}

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
    const { usage, own, limits } = refusal;
    return {
        ...plan,
        dropReason: `The session's volatile bound refused the send (${refusal.limit}): ${usage.admissions} of ` +
            `${limits.maxAdmissions} admissions, ${usage.bytes} of ${limits.maxBytes} bytes, of which its own sends ` +
            `hold ${own.admissions} admissions and ${own.bytes} bytes against a share of ` +
            `${AL_VOLATILE_SESSION_OWN_SHARE * 100}%, ${usage.tracks} of ${limits.maxTracks} tracks, a deadline at ` +
            `most ${limits.maxAgeMs} ms ahead.`,
        dropReasonCode: 'capacity',
        capacityLimit: refusal.limit,
        preparedMessages: []
    };
}

/** The refusal of a `capacity` drop; a congestion drop translated to `capacity` names no limit (D179). */
export function toALCapacityRefusedVerdict(
    limit: ALVolatileSessionLimit | undefined,
    detail: string
): ALDeliveryAdmissionVerdict {
    return limit === undefined
        ? { kind: 'refused', reason: 'capacity', detail }
        : { kind: 'refused', reason: 'capacity', limit, detail };
}
