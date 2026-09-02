import { describe, expect, it } from 'vitest';

import { GROUP_LIFECYCLE_STATES } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import type { GroupLifecyclePolicyRead } from '@shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts';
import {
    consultsTopologyReplanPolicy,
    resolveTopologyPlanAction,
    resolveTopologyReplanEnqueue,
    type ResolveTopologyPlanActionInput,
    type ResolveTopologyReplanEnqueueInput
} from '@shared-server/rallar-system/topology/planning/resolve-topology-plan-action.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';

import { createTestGroup } from '../../../../create-test-group.ts';

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

const ACTIVE_GROUP = createTestGroup({
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1',
    lifecycleState: 'active'
});
const PLANNED_LAYOUT = {
    state: 'active',
    version: 1,
    sourceGroupStateCausalRevision: { groupRevision: 1, presenceRevision: 0 }
} as RallarOverlayTopologySnapshot;
const PLANNED_IDENTITY = { groupRevision: 1, presenceRevision: 0, version: 1, state: 'active' } as const;
const COMMANDED_POLICY: GroupLifecyclePolicyRead = {
    status: 'present',
    policy: resolveGroupLifecyclePolicyPreset('match')
};

function enqueue(input: Partial<ResolveTopologyReplanEnqueueInput>): ReturnType<typeof resolveTopologyReplanEnqueue> {
    return resolveTopologyReplanEnqueue({
        group: { ...ACTIVE_GROUP, acceptedLayoutIdentity: PLANNED_IDENTITY },
        nowEpochMs: 1_000,
        workOrigin: 'automatic',
        mergeableHeadRow: false,
        policyFacts: { consulted: true, lifecyclePolicy: COMMANDED_POLICY, plannedLayout: PLANNED_LAYOUT },
        ...input
    });
}

describe('resolveTopologyReplanEnqueue', () => {
    it('holds exactly the automatic work the planner would freeze under the policy', () => {
        expect(enqueue({})).toBe('held-by-policy');
        expect(enqueue({ policyFacts: { consulted: true, lifecyclePolicy: { status: 'corrupt', reason: 'bad row' }, plannedLayout: PLANNED_LAYOUT } }))
            .toBe('held-by-policy');
        expect(enqueue({ workOrigin: 'commanded' })).toBe('enqueue');
        expect(enqueue({ policyFacts: { consulted: true, lifecyclePolicy: { status: 'absent' }, plannedLayout: PLANNED_LAYOUT } }))
            .toBe('enqueue');
    });

    it('never holds establishment: an absent or tombstoned planned slot always enqueues', () => {
        expect(enqueue({ policyFacts: { consulted: true, lifecyclePolicy: COMMANDED_POLICY, plannedLayout: null } })).toBe('enqueue');
        expect(enqueue({
            policyFacts: { consulted: true, lifecyclePolicy: COMMANDED_POLICY, plannedLayout: REMOVED_PREVIOUS }
        })).toBe('enqueue');
    });

    it('lets an inactive group publish its removal whatever the policy says', () => {
        expect(enqueue({ group: { ...ACTIVE_GROUP, acceptedLayoutIdentity: PLANNED_IDENTITY, expiresAtEpochMs: 999 } })).toBe('enqueue');
        expect(enqueue({ group: { ...ACTIVE_GROUP, acceptedLayoutIdentity: PLANNED_IDENTITY, expiresAtEpochMs: 1_001 } })).toBe('held-by-policy');
    });

    it('keeps merging a delta into a queued row it can still reach', () => {
        expect(enqueue({ mergeableHeadRow: true })).toBe('enqueue');
    });

    it('consults the policy only for the stage that follows it, in step with the planning gate', () => {
        for (const lifecycleState of GROUP_LIFECYCLE_STATES) {
            const group = { ...ACTIVE_GROUP, acceptedLayoutIdentity: PLANNED_IDENTITY, lifecycleState };
            const facts = { group, nowEpochMs: 1_000, workOrigin: 'automatic', mergeableHeadRow: false } as const;
            const consulted = consultsTopologyReplanPolicy(facts);
            expect({ lifecycleState, consulted }).toEqual({ lifecycleState, consulted: lifecycleState === 'active' });
            const held = enqueue({ group, ...(consulted ? {} : { policyFacts: { consulted: false } as const }) }) ===
                'held-by-policy';
            // Every stage the enqueue holds, the planner would have frozen too.
            expect(held ? action({ lifecycleState, replanning: 'commanded' }) : 'freeze').toBe('freeze');
        }
    });

    it('rejects a read that skipped the facts the gate must consult', () => {
        expect(() => enqueue({ policyFacts: { consulted: false } })).toThrow('stored policy facts');
    });
});
