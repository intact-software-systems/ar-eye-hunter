import { describe, expect, it } from 'vitest';

import type { GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import { computeGroupLifecycleTransition, type GroupLifecycleTransition } from '@shared/api/group-lifecycle/group-lifecycle-transitions.ts';

const STATES: readonly GroupLifecycleState[] = ['forming', 'connecting', 'active', 'reconfiguring'];

// The complete machine: every cell is either the one allowed target or denied.
const ALLOWED_CELLS: ReadonlyArray<{
    transition: GroupLifecycleTransition;
    from: GroupLifecycleState;
    to: GroupLifecycleState;
}> = [
    { transition: 'start-establishment', from: 'forming', to: 'connecting' },
    { transition: 'activate', from: 'connecting', to: 'active' },
    { transition: 'activate', from: 'reconfiguring', to: 'active' },
    { transition: 'reopen-establishment', from: 'active', to: 'reconfiguring' }
];

describe('computeGroupLifecycleTransition', () => {
    it('accepts exactly the four legal cells and advances the epoch on each', () => {
        for (const cell of ALLOWED_CELLS) {
            const outcome = computeGroupLifecycleTransition({
                transition: cell.transition,
                lifecycleState: cell.from,
                formationEpoch: 6
            });
            expect(outcome).toEqual({
                allowed: true,
                nextState: cell.to,
                nextFormationEpoch: 7
            });
        }
    });

    it('denies every other cell as lifecycle-transition-invalid', () => {
        const transitions: readonly GroupLifecycleTransition[] = ['start-establishment', 'activate', 'reopen-establishment'];
        let denied = 0;
        for (const transition of transitions) {
            for (const from of STATES) {
                if (ALLOWED_CELLS.some((cell) => cell.transition === transition && cell.from === from)) {
                    continue;
                }
                const outcome = computeGroupLifecycleTransition({
                    transition,
                    lifecycleState: from,
                    formationEpoch: 3
                });
                expect(outcome).toMatchObject({
                    allowed: false,
                    code: 'lifecycle-transition-invalid'
                });
                denied += 1;
            }
        }
        expect(denied).toBe(8);
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
