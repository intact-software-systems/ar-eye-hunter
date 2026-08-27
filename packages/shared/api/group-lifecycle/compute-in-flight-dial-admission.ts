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
 * The in-flight pacing rule (product decision 18): a peer shared by several
 * groups is one connection charged to every owning group's count, and its
 * setup starts only when every owning group has a free slot — it waits while
 * any one is at its bound, even if another is idle. The member's session-wide
 * cap remains a separate ceiling owned by the RTC layer.
 */
export function computeInFlightDialAdmission(
    input: ComputeInFlightDialAdmissionInput
): InFlightDialAdmission {
    const everyOwnerHasAFreeSlot = input.owningGroupBudgets.every(
        (budget) => budget.inFlightSetupCount < budget.maxConcurrentEdgeSetups
    );
    return everyOwnerHasAFreeSlot ? 'admit' : 'wait';
}
