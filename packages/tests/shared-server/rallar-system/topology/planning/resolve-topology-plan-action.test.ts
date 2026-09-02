import { describe, expect, it } from 'vitest';

import { GROUP_LIFECYCLE_STATES } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import {
    resolveTopologyPlanAction,
    resolveTopologyReplanEnqueue,
    type ResolveTopologyPlanActionInput,
    type ResolveTopologyReplanEnqueueInput
} from '@shared-server/rallar-system/topology/planning/resolve-topology-plan-action.ts';

const ACTIVE_PREVIOUS = { state: 'active' } as RallarOverlayTopologySnapshot;
const REMOVED_PREVIOUS = { state: 'removed' } as RallarOverlayTopologySnapshot;

function action(input: Partial<ResolveTopologyPlanActionInput>): ReturnType<typeof resolveTopologyPlanAction> {
    return resolveTopologyPlanAction({
        lifecycleState: 'active',
        replanning: 'debounced',
        workOrigin: 'automatic',
        previous: ACTIVE_PREVIOUS,
        ...input
    });
}

describe('resolveTopologyPlanAction', () => {
    it('is total over the stage registry against an active stored layout', () => {
        const byStage = Object.fromEntries(
            GROUP_LIFECYCLE_STATES.map((lifecycleState) => [lifecycleState, action({ lifecycleState })])
        );
        expect(byStage).toEqual({
            dormant: 'publish-removal',
            forming: 'publish-removal',
            planned: 'plan',
            connecting: 'freeze',
            active: 'plan',
            reconfiguring: 'plan',
            reconnecting: 'freeze'
        });
    });

    it('never suppresses establishment: absent and tombstoned slots always plan outside the removal rows', () => {
        for (const lifecycleState of GROUP_LIFECYCLE_STATES) {
            for (const previous of [undefined, REMOVED_PREVIOUS]) {
                const resolved = action({ lifecycleState, replanning: 'commanded', previous });
                expect(resolved).toBe(
                    lifecycleState === 'dormant' || lifecycleState === 'forming'
                        ? 'publish-removal'
                        : 'plan'
                );
            }
        }
    });

    it('follows the replanning policy only for active groups', () => {
        expect(action({ replanning: 'commanded', workOrigin: 'automatic' })).toBe('freeze');
        expect(action({ replanning: 'commanded', workOrigin: 'commanded' })).toBe('plan');
        expect(action({ replanning: 'corrupt', workOrigin: 'automatic' })).toBe('freeze');
        expect(action({ replanning: 'corrupt', workOrigin: 'commanded' })).toBe('plan');
        expect(action({ replanning: 'auto' })).toBe('plan');
        expect(action({ replanning: 'debounced' })).toBe('plan');
    });

    it('freezes dialing stages for commanded work too', () => {
        expect(action({ lifecycleState: 'connecting', workOrigin: 'commanded' })).toBe('freeze');
        expect(action({ lifecycleState: 'reconnecting', workOrigin: 'commanded' })).toBe('freeze');
    });
});

function enqueue(input: Partial<ResolveTopologyReplanEnqueueInput>): ReturnType<typeof resolveTopologyReplanEnqueue> {
    return resolveTopologyReplanEnqueue({
        lifecycleState: 'active',
        replanning: 'commanded',
        workOrigin: 'automatic',
        plannedLayoutActive: true,
        ...input
    });
}

describe('resolveTopologyReplanEnqueue', () => {
    it('holds only the automatic work the planner would freeze', () => {
        expect(enqueue({})).toBe('held-by-policy');
        expect(enqueue({ replanning: 'corrupt' })).toBe('held-by-policy');
        expect(enqueue({ workOrigin: 'commanded' })).toBe('enqueue');
        expect(enqueue({ replanning: 'auto' })).toBe('enqueue');
        expect(enqueue({ replanning: 'debounced' })).toBe('enqueue');
    });

    it('never holds establishment: an absent or tombstoned planned slot always enqueues', () => {
        expect(enqueue({ plannedLayoutActive: false })).toBe('enqueue');
        expect(enqueue({ plannedLayoutActive: false, replanning: 'corrupt' })).toBe('enqueue');
    });

    it('consults the policy only for the stage that follows it, in step with the planning gate', () => {
        for (const lifecycleState of GROUP_LIFECYCLE_STATES) {
            const held = enqueue({ lifecycleState }) === 'held-by-policy';
            const frozen = action({ lifecycleState, replanning: 'commanded' }) === 'freeze';
            expect({ lifecycleState, held }).toEqual({
                lifecycleState,
                held: lifecycleState === 'active'
            });
            // Every stage the enqueue holds, the planner would have frozen too.
            expect(held ? frozen : true).toBe(true);
        }
    });
});
