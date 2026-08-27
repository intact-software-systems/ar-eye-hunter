export type InFlightDialAdmission =
    | 'admit'
    | 'wait';

export interface GroupInFlightDialBudget {
    readonly inFlightSetupCount: number;
    readonly maxConcurrentEdgeSetups: number;
}

export interface ComputeInFlightDialAdmissionInput {
    /** One entry per group that wants this peer; empty means no group bounds it. */
    readonly owningGroupBudgets: readonly GroupInFlightDialBudget[];
}

/**
 * The in-flight pacing rule (product decision 18): a shared peer waits while
 * any owning group is at its bound, even if another is idle — starting anyway
 * would put the saturated group over the bound its own policy asked for. The
 * member's session-wide cap remains a separate ceiling owned by the RTC layer.
 */
export function computeInFlightDialAdmission(
    input: ComputeInFlightDialAdmissionInput
): InFlightDialAdmission {
    const everyOwnerHasAFreeSlot = input.owningGroupBudgets.every(
        (budget) => budget.inFlightSetupCount < budget.maxConcurrentEdgeSetups
    );
    return everyOwnerHasAFreeSlot ? 'admit' : 'wait';
}
