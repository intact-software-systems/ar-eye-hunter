import type { GroupActivationCriterion } from './group-lifecycle-policy.ts';

/**
 * Retry pacing for below-floor returns. The criterion carries no backoff knob
 * (plan decision 3 subsumed `onDeadline`, not pacing), so pacing is a server
 * default: linear in the attempt count, capped, never faster than the escalse.
 */
export const DEFAULT_FORMATION_RETRY_BACKOFF_MS = 5_000;
export const MAX_FORMATION_RETRY_BACKOFF_MS = 60_000;

export function computeFormationRetryBackoffMs(nextAttemptCount: number): number {
    return Math.min(
        DEFAULT_FORMATION_RETRY_BACKOFF_MS * Math.max(1, nextAttemptCount),
        MAX_FORMATION_RETRY_BACKOFF_MS
    );
}

export type GroupActivationDecision =
    | Readonly<{ decision: 'wait'; }>
    | Readonly<{ decision: 'activate' | 'activate-degraded'; }>
    | Readonly<{ decision: 'below-floor'; retryAllowed: boolean; }>;

/**
 * The criterion, decided against two rates: at or above `successRate` the
 * group activates, at or above `minimumViableRate` at the deadline it
 * activates degraded, and below the floor at the deadline it does not
 * activate at all (plan decision 3). Pure over its inputs; `manual` mode
 * always waits because activation is then an operator command, and a missing
 * deadline anchor waits because the deadline half has nothing to measure from.
 */
export function evaluateGroupActivationCriterion(
    input: Readonly<{
        activation: GroupActivationCriterion;
        observedRate: number;
        establishmentStartedAtEpochMs: number | null;
        formationAttemptCount: number;
        nowEpochMs: number;
    }>
): GroupActivationDecision {
    const { activation, observedRate } = input;
    if (activation.mode === 'manual') {
        return { decision: 'wait' };
    }
    const thresholdArmed = activation.mode === 'threshold' ||
        activation.mode === 'threshold-or-deadline';
    if (thresholdArmed && observedRate >= activation.successRate) {
        return { decision: 'activate' };
    }
    const deadlineArmed = activation.mode === 'deadline' ||
        activation.mode === 'threshold-or-deadline';
    if (!deadlineArmed || input.establishmentStartedAtEpochMs === null) {
        return { decision: 'wait' };
    }
    const deadlineAtEpochMs = input.establishmentStartedAtEpochMs + activation.deadlineMs;
    if (input.nowEpochMs < deadlineAtEpochMs) {
        return { decision: 'wait' };
    }
    if (observedRate >= activation.successRate) {
        return { decision: 'activate' };
    }
    if (observedRate >= activation.minimumViableRate) {
        return { decision: 'activate-degraded' };
    }
    return {
        decision: 'below-floor',
        retryAllowed: input.formationAttemptCount + 1 < activation.maxFormationAttempts
    };
}
