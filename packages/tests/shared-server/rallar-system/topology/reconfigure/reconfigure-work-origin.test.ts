import { describe, expect, it } from 'vitest';

import {
    resolveTopologyPlanAction,
    type ResolveTopologyPlanActionInput
} from '@shared-server/rallar-system/topology/planning/resolve-topology-plan-action.ts';

const ACTIVE_LAYOUT = { state: 'active' } as ResolveTopologyPlanActionInput['previous'];

/**
 * Product decision 4: commanded groups advance on application commands. The
 * `reconfigure` route exists to command a replan, so the work it enqueues must
 * carry a commanded origin -- it was stamped `automatic`, which is precisely
 * what `commanded` and `corrupt` replanning freeze, so the one mode that
 * exists to honour the command was the mode that discarded it.
 */
describe('an application command is not frozen by the mode that honours it', () => {
    it('plans commanded work under every replanning mode', () => {
        for (const replanning of ['auto', 'debounced', 'commanded', 'corrupt'] as const) {
            expect(planActionFor(replanning, 'commanded'), replanning).toBe('plan');
        }
    });

    it('freezes automatic work only where the policy holds it', () => {
        expect(planActionFor('auto', 'automatic')).toBe('plan');
        expect(planActionFor('debounced', 'automatic')).toBe('plan');
        expect(planActionFor('commanded', 'automatic')).toBe('freeze');
        // A policy that cannot be read replans no more than `commanded` does.
        expect(planActionFor('corrupt', 'automatic')).toBe('freeze');
    });
});

function planActionFor(
    replanning: ResolveTopologyPlanActionInput['replanning'],
    workOrigin: ResolveTopologyPlanActionInput['workOrigin']
): string {
    return resolveTopologyPlanAction({
        lifecycleState: 'active',
        replanning,
        workOrigin,
        previous: ACTIVE_LAYOUT
    });
}
