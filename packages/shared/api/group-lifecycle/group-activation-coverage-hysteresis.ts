import type { GroupActivationCondition, GroupCoverageObservation } from './compute-group-activation-condition.ts';

export interface ResolveGroupActivationCoverageInput {
    readonly coverage: GroupCoverageObservation;
    /** The condition last written for this group; `undefined` before the first. */
    readonly previousCondition: GroupActivationCondition | undefined;
    readonly hysteresisWidth: number;
}

/**
 * Coverage thresholds with hysteresis, so a group hovering on a boundary
 * keeps its condition instead of flapping between two bands and writing a
 * group CAS, a durable event and a WS fan on every crossing.
 *
 * Entry thresholds are the policy's own `successRate` and
 * `minimumViableRate`. A band the group already holds exits only once
 * coverage falls a configured WIDTH below that entry -- a width, never an
 * absolute rate, so a per-group policy patch cannot invert the band. Only
 * the band currently held is relaxed, and upgrades follow the entry
 * thresholds immediately.
 *
 * Returns the observation the condition should be judged by, so the
 * precedence in `computeGroupActivationCondition` stays the single place
 * that decides what a rate means.
 */
export function resolveGroupActivationCoverageWithHysteresis(
    input: ResolveGroupActivationCoverageInput
): GroupCoverageObservation {
    if (input.previousCondition === 'active') {
        return {
            ...input.coverage,
            successRate: Math.max(
                input.coverage.minimumViableRate,
                input.coverage.successRate - input.hysteresisWidth
            )
        };
    }
    if (input.previousCondition === 'degraded') {
        return {
            ...input.coverage,
            minimumViableRate: Math.max(0, input.coverage.minimumViableRate - input.hysteresisWidth)
        };
    }
    return input.coverage;
}
