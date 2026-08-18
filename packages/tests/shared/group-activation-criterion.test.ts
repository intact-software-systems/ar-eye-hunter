import { describe, expect, it } from 'vitest';

import type { GroupActivationCriterion } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
// prettier-ignore
import {
    computeFormationRetryBackoffMs,
    DEFAULT_FORMATION_RETRY_BACKOFF_MS,
    evaluateGroupActivationCriterion,
    MAX_FORMATION_RETRY_BACKOFF_MS,
} from '@shared/api/group-lifecycle/evaluate-group-activation-criterion.ts';

const NOW = 1_000_000;
const STARTED = NOW - 25_000;

function criterion(overrides: Partial<GroupActivationCriterion>): GroupActivationCriterion {
    return {
        mode: 'threshold-or-deadline',
        successRate: 0.95,
        minimumViableRate: 0.5,
        deadlineMs: 20_000,
        maxFormationAttempts: 3,
        strictConfirmation: false,
        ...overrides,
    };
}

function evaluate(input: Readonly<{
    activation: GroupActivationCriterion;
    observedRate: number;
    establishmentStartedAtEpochMs?: number | null;
    formationAttemptCount?: number;
    nowEpochMs?: number;
}>) {
    return evaluateGroupActivationCriterion({
        establishmentStartedAtEpochMs: STARTED,
        formationAttemptCount: 0,
        nowEpochMs: NOW,
        ...input,
    });
}

describe('evaluateGroupActivationCriterion', () => {
    it('always waits in manual mode', () => {
        expect(evaluate({
            activation: criterion({ mode: 'manual', successRate: 0 }),
            observedRate: 1,
        })).toEqual({ decision: 'wait' });
    });

    it('activates on threshold regardless of the deadline', () => {
        for (const mode of ['threshold', 'threshold-or-deadline'] as const) {
            expect(evaluate({
                activation: criterion({ mode }),
                observedRate: 0.95,
                nowEpochMs: STARTED + 1,
            })).toEqual({ decision: 'activate' });
        }
    });

    it('waits below threshold before the deadline', () => {
        expect(evaluate({
            activation: criterion({}),
            observedRate: 0.9,
            nowEpochMs: STARTED + 10_000,
        })).toEqual({ decision: 'wait' });
    });

    it('waits in pure threshold mode forever below the rate', () => {
        expect(evaluate({
            activation: criterion({ mode: 'threshold' }),
            observedRate: 0.9,
            nowEpochMs: STARTED + 1_000_000,
        })).toEqual({ decision: 'wait' });
    });

    it('decides the three bands at the deadline', () => {
        expect(evaluate({ activation: criterion({}), observedRate: 0.95 }))
            .toEqual({ decision: 'activate' });
        expect(evaluate({ activation: criterion({}), observedRate: 0.7 }))
            .toEqual({ decision: 'activate-degraded' });
        expect(evaluate({ activation: criterion({}), observedRate: 0.4 }))
            .toEqual({ decision: 'below-floor', retryAllowed: true });
    });

    it('treats floor equal to success rate as all-or-nothing', () => {
        const allOrNothing = criterion({ successRate: 1, minimumViableRate: 1, mode: 'deadline' });
        expect(evaluate({ activation: allOrNothing, observedRate: 1 }))
            .toEqual({ decision: 'activate' });
        expect(evaluate({ activation: allOrNothing, observedRate: 0.94 }))
            .toEqual({ decision: 'below-floor', retryAllowed: true });
    });

    it('stops allowing retries at maxFormationAttempts', () => {
        expect(evaluate({
            activation: criterion({}),
            observedRate: 0,
            formationAttemptCount: 2,
        })).toEqual({ decision: 'below-floor', retryAllowed: false });
    });

    it('waits without a deadline anchor even past any plausible deadline', () => {
        expect(evaluate({
            activation: criterion({ mode: 'deadline' }),
            observedRate: 0,
            establishmentStartedAtEpochMs: null,
        })).toEqual({ decision: 'wait' });
    });

    it('never auto-activates on threshold in pure deadline mode', () => {
        expect(evaluate({
            activation: criterion({ mode: 'deadline' }),
            observedRate: 1,
            nowEpochMs: STARTED + 1,
        })).toEqual({ decision: 'wait' });
    });
});

describe('computeFormationRetryBackoffMs', () => {
    it('escalates linearly with the attempt count and caps', () => {
        expect(computeFormationRetryBackoffMs(1)).toBe(DEFAULT_FORMATION_RETRY_BACKOFF_MS);
        expect(computeFormationRetryBackoffMs(3)).toBe(3 * DEFAULT_FORMATION_RETRY_BACKOFF_MS);
        expect(computeFormationRetryBackoffMs(100)).toBe(MAX_FORMATION_RETRY_BACKOFF_MS);
    });
});
