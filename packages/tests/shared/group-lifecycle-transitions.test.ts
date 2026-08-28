import { describe, expect, it } from 'vitest';

import { GROUP_LIFECYCLE_STATES, type GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import {
    computeGroupLifecycleTransition,
    resolveFormationFailureLanding,
    type GroupLifecycleTransition
} from '@shared/api/group-lifecycle/group-lifecycle-transitions.ts';

const EVERY_TRANSITION: readonly GroupLifecycleTransition[] = [
    'reset',
    'start',
    'plan',
    'connect',
    'start-establishment',
    'activate',
    'reconfigure',
    'reopen-establishment',
    'fail-formation'
];

// The complete machine, keyed (stage, command) -> stage: every cell is either
// the one allowed target or denied. The legacy commands keep today's cells
// until their retirement; reconfiguring's activate/fail-formation cells leave
// with them.
const ALLOWED_CELLS: ReadonlyArray<{
    transition: GroupLifecycleTransition;
    from: GroupLifecycleState;
    to: GroupLifecycleState;
}> = [
    { transition: 'reset', from: 'dormant', to: 'dormant' },
    { transition: 'start', from: 'dormant', to: 'forming' },
    { transition: 'reset', from: 'forming', to: 'dormant' },
    { transition: 'plan', from: 'forming', to: 'planned' },
    { transition: 'start-establishment', from: 'forming', to: 'connecting' },
    { transition: 'reset', from: 'planned', to: 'dormant' },
    { transition: 'plan', from: 'planned', to: 'planned' },
    { transition: 'connect', from: 'planned', to: 'connecting' },
    { transition: 'reset', from: 'connecting', to: 'dormant' },
    { transition: 'activate', from: 'connecting', to: 'active' },
    { transition: 'fail-formation', from: 'connecting', to: 'forming' },
    { transition: 'reset', from: 'active', to: 'dormant' },
    { transition: 'reconfigure', from: 'active', to: 'reconfiguring' },
    { transition: 'reopen-establishment', from: 'active', to: 'reconfiguring' },
    { transition: 'reset', from: 'reconfiguring', to: 'dormant' },
    { transition: 'connect', from: 'reconfiguring', to: 'reconnecting' },
    { transition: 'activate', from: 'reconfiguring', to: 'active' },
    { transition: 'fail-formation', from: 'reconfiguring', to: 'forming' },
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
        expect(ALLOWED_CELLS).toHaveLength(21);
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
        let denied = 0;
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
                denied += 1;
            }
        }
        expect(denied).toBe(42);
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
        { lifecycleState: 'reconfiguring' as const, exhausted: false, landing: 'forming' },
        { lifecycleState: 'reconfiguring' as const, exhausted: true, landing: 'dormant' },
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
                lifecycleState === 'reconfiguring' ||
                lifecycleState === 'reconnecting'
            ) {
                continue;
            }
            expect(resolveFormationFailureLanding({ lifecycleState, attemptBudgetExhausted: true }))
                .toBeUndefined();
        }
    });
});
