import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type {
    ALVolatileSessionBudget,
    ALVolatileSessionUsage
} from '../../volatile-budget/al-volatile-session-budget.ts';
import { toALVolatileSessionAdmission } from '../../volatile-budget/to-al-volatile-session-admission.ts';
import type { ALInboundMessageRuntime } from '../al-inbound-message-runtime.ts';

export interface AdmitALInboundVolatileBudgetInput {
    readonly msg: ALMessage;
    readonly acceptance: ALInboundMessageRuntime.Acceptance | undefined;
    readonly budget: ALVolatileSessionBudget | undefined;
    readonly nowMs: number;
}

export function admitALInboundVolatileBudget(
    input: AdmitALInboundVolatileBudgetInput
): ALVolatileSessionUsage | undefined {
    const kind = input.acceptance?.kind;
    if (input.budget === undefined || (kind !== 'admitted' && kind !== 'pending-admission')) {
        return undefined;
    }
    const admission = toALVolatileSessionAdmission(input.msg, input.nowMs);
    return admission === undefined ? undefined : input.budget.record(admission);
}
