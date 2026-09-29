import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type {
    ALVolatileSessionBudget,
    ALVolatileSessionUsage
} from '../../volatile-budget/al-volatile-session-budget.ts';
import { toALVolatileSessionAdmission } from '../../volatile-budget/to-al-volatile-session-admission.ts';
import type { ALInboundMessageRuntime } from '../al-inbound-message-runtime.ts';

export interface AdmitALInboundVolatileBudgetInput {
    readonly msg: ALMessage;
    /** What the memory lane answered; `undefined` for an arrival it rejected. */
    readonly acceptance: ALInboundMessageRuntime.Acceptance | undefined;
    readonly budget: ALVolatileSessionBudget | undefined;
    readonly nowMs: number;
}

/**
 * Counts a data message the session's memory lane admitted against the session's bound (D74). An inbound
 * admission is never refused for capacity (C6): it raises the usage the session's own sends and `overloaded`
 * read, for at most `AL_VOLATILE_SESSION_INBOUND_COUNTED_LIFETIME_MS`. A duplicate, a rejection and a message
 * whose sender named no deadline count nothing.
 */
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
