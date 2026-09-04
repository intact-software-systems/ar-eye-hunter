import {
    computeGroupActivationCondition,
    GROUP_ACTIVATION_HYSTERESIS_WIDTH,
    GROUP_ACTIVATION_STATUS_DWELL_MS,
    type ComputeGroupActivationConditionInput,
    type GroupActivationCondition,
    type GroupCoverageObservation
} from './compute-group-activation-condition.ts';
import { resolveGroupActivationCoverageWithHysteresis } from './group-activation-coverage-hysteresis.ts';

export interface ResolveGroupActivationStatusActionInput {
    readonly business: ComputeGroupActivationConditionInput['business'];
    readonly lifecycleState: ComputeGroupActivationConditionInput['lifecycleState'];
    readonly attemptBudgetExhausted: boolean;
    readonly coverage: Omit<GroupCoverageObservation, 'dwellSatisfied'>;
    readonly previousCondition: GroupActivationCondition | undefined;
    readonly nowEpochMs: number;
    readonly dwellMs?: number;
}

/**
 * What a reading should do, decided once so the petition and the clock cannot
 * disagree.
 *
 * `write` publishes immediately. `arm-dwell` publishes nothing and asks for a
 * durable clock at `dueAtEpochMs`, because the band the coverage implies is
 * one only a clock may confirm. `none` means the band already on the row.
 *
 * A band is dwell-gated when it is *reachable only* with the dwell satisfied,
 * which is asked of the condition computer rather than hardcoded: compute the
 * band both ways and see whether the answer moves. That keeps this in step
 * with the product's precedence table instead of duplicating it.
 */
export type GroupActivationStatusAction =
    | Readonly<{ kind: 'write'; condition: GroupActivationCondition; }>
    | Readonly<{ kind: 'arm-dwell'; condition: GroupActivationCondition; dueAtEpochMs: number; }>
    | Readonly<{ kind: 'none'; }>;

export function resolveGroupActivationStatusAction(
    input: ResolveGroupActivationStatusActionInput
): GroupActivationStatusAction {
    const banded = resolveGroupActivationCoverageWithHysteresis({
        coverage: { ...input.coverage, dwellSatisfied: false },
        previousCondition: input.previousCondition,
        hysteresisWidth: GROUP_ACTIVATION_HYSTERESIS_WIDTH
    });
    const withoutDwell = toCondition(input, { ...banded, dwellSatisfied: false });
    const withDwell = toCondition(input, { ...banded, dwellSatisfied: true });
    if (withDwell === withoutDwell) {
        return withoutDwell === input.previousCondition
            ? { kind: 'none' }
            : { kind: 'write', condition: withoutDwell };
    }
    // The bands disagree, so the coverage implies a band only a clock may
    // confirm. Publishing `withoutDwell` here would report the group healthier
    // than the evidence says while the dwell is still running.
    return withDwell === input.previousCondition ? { kind: 'none' } : {
        kind: 'arm-dwell',
        condition: withDwell,
        dueAtEpochMs: input.nowEpochMs + (input.dwellMs ?? GROUP_ACTIVATION_STATUS_DWELL_MS)
    };
}

function toCondition(
    input: ResolveGroupActivationStatusActionInput,
    coverage: GroupCoverageObservation
): GroupActivationCondition {
    return computeGroupActivationCondition({
        business: input.business,
        lifecycleState: input.lifecycleState,
        attemptBudgetExhausted: input.attemptBudgetExhausted,
        coverage
    });
}
