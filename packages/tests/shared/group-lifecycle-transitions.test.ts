import { describe, expect, it } from 'vitest';

import { GROUP_LIFECYCLE_STATES, type GroupActivationCriterion, type GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import {
    computeGroupLifecycleTransition,
    denyExhaustedFormationSeries,
    isFormationAttemptBudgetExhausted,
    resolveFormationFailureLanding,
    type GroupLifecycleTransition
} from '@shared/api/group-lifecycle/group-lifecycle-transitions.ts';

const EVERY_TRANSITION: readonly GroupLifecycleTransition[] = [
    'reset',
    'start',
    'plan',
    'connect',
    'activate',
    'reconfigure',
    'fail-formation'
];

// The complete public state machine: holds cannot activate or fail before connect.
const ALLOWED_CELLS: ReadonlyArray<{
    transition: GroupLifecycleTransition;
    from: GroupLifecycleState;
    to: GroupLifecycleState;
}> = [
    { transition: 'reset', from: 'dormant', to: 'dormant' },
    { transition: 'start', from: 'dormant', to: 'forming' },
    { transition: 'reset', from: 'forming', to: 'dormant' },
    { transition: 'plan', from: 'forming', to: 'planned' },
    { transition: 'reset', from: 'planned', to: 'dormant' },
    { transition: 'plan', from: 'planned', to: 'planned' },
    { transition: 'connect', from: 'planned', to: 'connecting' },
    { transition: 'reset', from: 'connecting', to: 'dormant' },
    { transition: 'activate', from: 'connecting', to: 'active' },
    { transition: 'fail-formation', from: 'connecting', to: 'forming' },
    { transition: 'reset', from: 'active', to: 'dormant' },
    { transition: 'reconfigure', from: 'active', to: 'reconfiguring' },
    { transition: 'reset', from: 'reconfiguring', to: 'dormant' },
    { transition: 'connect', from: 'reconfiguring', to: 'reconnecting' },
    { transition: 'reset', from: 'reconnecting', to: 'dormant' },
    { transition: 'activate', from: 'reconnecting', to: 'active' },
    { transition: 'fail-formation', from: 'reconnecting', to: 'active' }
];

describe('computeGroupLifecycleTransition', () => {
    it('accepts exactly the legal cells and advances the epoch on each', () => {
        for (const cell of ALLOWED_CELLS) {
            const idempotentReplan = cell.transition === 'plan' && cell.from === 'planned';
            const outcome = computeGroupLifecycleTransition({
                transition: cell.transition,
                lifecycleState: cell.from,
                formationEpoch: 6
            });
            expect(outcome, `${cell.transition} from ${cell.from}`).toEqual({
                allowed: true,
                nextState: cell.to,
                idempotentReplan,
                nextFormationEpoch: idempotentReplan ? 6 : 7
            });
        }
    });

    // Product decision 28: plan is idempotently legal from planned. Idempotence
    // is only real if a repeat advances nothing — an epoch bump would re-pin
    // the electorate and turn every outstanding causal fence stale.
    it('keeps the formation epoch on an idempotent replan', () => {
        const outcome = computeGroupLifecycleTransition({
            transition: 'plan',
            lifecycleState: 'planned',
            formationEpoch: 4
        });
        expect(outcome).toEqual({
            allowed: true,
            nextState: 'planned',
            idempotentReplan: true,
            nextFormationEpoch: 4
        });
    });

    it('denies every other cell as lifecycle-transition-invalid', () => {
        for (const transition of EVERY_TRANSITION) {
            for (const from of GROUP_LIFECYCLE_STATES) {
                if (ALLOWED_CELLS.some((cell) => cell.transition === transition && cell.from === from)) {
                    continue;
                }
                const outcome = computeGroupLifecycleTransition({
                    transition,
                    lifecycleState: from,
                    formationEpoch: 3
                });
                expect(outcome, `${transition} from ${from}`).toMatchObject({
                    allowed: false,
                    code: 'lifecycle-transition-invalid'
                });
            }
        }
    });

    it('reports the offending transition and state in the denial details', () => {
        const outcome = computeGroupLifecycleTransition({
            transition: 'activate',
            lifecycleState: 'forming',
            formationEpoch: 0
        });
        expect(outcome).toMatchObject({
            allowed: false,
            details: { transition: 'activate', lifecycleState: 'forming' }
        });
    });
});

describe('resolveFormationFailureLanding', () => {
    // Exhaustion is terminal for automation and lands in dormant; an
    // unexhausted failure follows the table -- forming where no accepted
    // layout exists yet, active where one does (product decisions 28 and 35).
    it.each([
        { lifecycleState: 'connecting' as const, exhausted: false, landing: 'forming' },
        { lifecycleState: 'connecting' as const, exhausted: true, landing: 'dormant' },
        { lifecycleState: 'reconnecting' as const, exhausted: false, landing: 'active' },
        { lifecycleState: 'reconnecting' as const, exhausted: true, landing: 'dormant' }
    ])('lands $lifecycleState exhausted=$exhausted in $landing', (row) => {
        expect(resolveFormationFailureLanding({
            lifecycleState: row.lifecycleState,
            attemptBudgetExhausted: row.exhausted
        })).toBe(row.landing);
    });

    it('has no failure landing outside the dialing stages', () => {
        for (const lifecycleState of GROUP_LIFECYCLE_STATES) {
            if (
                lifecycleState === 'connecting' ||
                lifecycleState === 'reconnecting'
            ) {
                continue;
            }
            expect(resolveFormationFailureLanding({ lifecycleState, attemptBudgetExhausted: true }))
                .toBeUndefined();
        }
    });
});

function activationAllowing(maxFormationAttempts: number): GroupActivationCriterion {
    return {
        mode: 'threshold-or-deadline',
        successRate: 1,
        minimumViableRate: 1,
        deadlineMs: 1_000,
        maxFormationAttempts,
        strictConfirmation: false
    };
}

describe('isFormationAttemptBudgetExhausted', () => {
    // The frame is attempts already recorded, so a two-attempt budget is spent
    // at two and not at three. A caller asking whether the attempt it is about
    // to record may be followed by another passes the incremented count, which
    // is what the criterion's retryAllowed does.
    it.each([
        { formationAttemptCount: 0, exhausted: false },
        { formationAttemptCount: 1, exhausted: false },
        { formationAttemptCount: 2, exhausted: true },
        { formationAttemptCount: 3, exhausted: true }
    ])('$formationAttemptCount of 2 attempts is exhausted=$exhausted', (row) => {
        expect(isFormationAttemptBudgetExhausted({
            activation: activationAllowing(2),
            formationAttemptCount: row.formationAttemptCount
        })).toBe(row.exhausted);
    });
});

describe('denyExhaustedFormationSeries', () => {
    it.each([
        { formationAttemptCount: 1, denied: false },
        { formationAttemptCount: 2, denied: true }
    ])('start with $formationAttemptCount of 2 attempts is denied=$denied', (row) => {
        const denial = denyExhaustedFormationSeries({
            transition: 'start',
            activation: activationAllowing(2),
            formationAttemptCount: row.formationAttemptCount
        });
        expect(denial !== undefined).toBe(row.denied);
    });

    it('names the exhausted-series code and the counts that produced it', () => {
        expect(denyExhaustedFormationSeries({
            transition: 'start',
            activation: activationAllowing(2),
            formationAttemptCount: 2
        })).toMatchObject({
            allowed: false,
            code: 'formation-attempts-exhausted',
            details: { formationAttemptCount: 2, maxFormationAttempts: 2 }
        });
    });

    // The budget bounds one series and start is its only entrance, so every
    // other transition passes a spent budget untouched -- the exhausted
    // fail-formation landing is resolveFormationFailureLanding's, not this.
    it('bounds start alone, whatever the budget says', () => {
        for (const transition of EVERY_TRANSITION) {
            if (transition === 'start') {
                continue;
            }
            expect(
                denyExhaustedFormationSeries({
                    transition,
                    activation: activationAllowing(1),
                    formationAttemptCount: 9
                }),
                transition
            ).toBeUndefined();
        }
    });
});
