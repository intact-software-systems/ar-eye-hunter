import { createDefaultGroupLifecyclePolicy, resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import {
    GROUP_LIFECYCLE_POLICY_PRESET_NAMES,
    type GroupLifecyclePolicy,
    type GroupLifecyclePolicyIssueCode
} from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import {
    MAX_GROUP_FORMATION_DEADLINE_MS,
    MAX_GROUP_MANAGERS,
    MAX_GROUP_STAGE_TRIGGER_DELAY_MS,
    MAX_GROUP_TOPOLOGY_DEBOUNCE_WINDOW_MS,
    MAX_GROUP_TOPOLOGY_REPLAN_WAIT_MS,
    toNormalizedGroupLifecyclePolicy
} from '@shared/api/group-lifecycle/to-normalized-group-lifecycle-policy.ts';
import { validateGroupLifecyclePolicy } from '@shared/api/group-lifecycle/validate-group-lifecycle-policy.ts';
import { describe, expect, it } from 'vitest';

function toIssueCodes(policy: GroupLifecyclePolicy): readonly GroupLifecyclePolicyIssueCode[] {
    return validateGroupLifecyclePolicy(policy).left?.map((issue) => issue.code) ?? [];
}

describe('group lifecycle policy defaults', () => {
    // The property the whole workstream rests on: a group created without a
    // policy behaves exactly as groups behave today. If this ever changes,
    // every existing group silently changes behaviour.
    it('defaults to the optimistic preset, which is today behaviour', () => {
        const policy = createDefaultGroupLifecyclePolicy();

        expect(policy).toEqual(resolveGroupLifecyclePolicyPreset('optimistic'));
        expect(policy.formation).toBe('immediate');
        expect(policy.admission.mode).toBe('open');
        expect(policy.data.preActivationAppData).toBe('allowed');
        expect(policy.manager.selection).toBe('none');
    });

    it('normalizes absent input to the default', () => {
        expect(toNormalizedGroupLifecyclePolicy()).toEqual(createDefaultGroupLifecyclePolicy());
        expect(toNormalizedGroupLifecyclePolicy({})).toEqual(createDefaultGroupLifecyclePolicy());
    });

    it.each(GROUP_LIFECYCLE_POLICY_PRESET_NAMES)('ships %s as a valid policy', (name) => {
        expect(toIssueCodes(resolveGroupLifecyclePolicyPreset(name))).toEqual([]);
    });

    // The floor equalling the success rate is how match asks for
    // all-or-nothing, which is what replaced the removed fail-formation.
    it('gives match an all-or-nothing criterion', () => {
        const match = resolveGroupLifecyclePolicyPreset('match');

        expect(match.activation.minimumViableRate).toBe(match.activation.successRate);
        expect(match.admission.mode).toBe('closed');
        expect(match.data.preActivationAppData).toBe('blocked-until-active');
    });

    // Product decision 6's replanning and landing table, pinned per preset.
    it.each([
        { name: 'optimistic' as const, replanning: 'auto', reconfigureLanding: 'apply' },
        { name: 'managed' as const, replanning: 'debounced', reconfigureLanding: 'apply' },
        { name: 'match' as const, replanning: 'commanded', reconfigureLanding: 'hold' },
        { name: 'drop-in-social' as const, replanning: 'debounced', reconfigureLanding: 'apply' }
    ])('gives $name the $replanning / $reconfigureLanding topology policy', (row) => {
        const preset = resolveGroupLifecyclePolicyPreset(row.name);

        expect(preset.topology.replanning).toBe(row.replanning);
        expect(preset.topology.reconfigureLanding).toBe(row.reconfigureLanding);
    });

    // The manager curates who is in and when the group starts, not the wiring:
    // one manager plan command starts the dialing.
    it('gives managed a manual plan trigger and an immediate connect trigger', () => {
        const managed = resolveGroupLifecyclePolicyPreset('managed');

        expect(managed.establishment.planTrigger).toEqual({ kind: 'manual' });
        expect(managed.establishment.connectTrigger).toEqual({ kind: 'immediate' });
    });
});

describe('group lifecycle policy normalization', () => {
    it('layers sparse input over the named preset', () => {
        const policy = toNormalizedGroupLifecyclePolicy({
            preset: 'managed',
            admission: { mode: 'closed' }
        });

        expect(policy.admission.mode).toBe('closed');
        expect(policy.formation).toBe('phased');
        expect(policy.initiator).toBe('manager');
    });

    it('layers the initiator and topology fields over the preset', () => {
        const policy = toNormalizedGroupLifecyclePolicy({
            preset: 'managed',
            initiator: 'any-member',
            topology: { replanning: 'auto' }
        });

        expect(policy.initiator).toBe('any-member');
        expect(policy.topology.replanning).toBe('auto');
        expect(policy.topology.reconfigureLanding).toBe('apply');
    });

    it('clamps the trigger and replanning windows to their server bounds', () => {
        const policy = toNormalizedGroupLifecyclePolicy({
            establishment: {
                planTrigger: { kind: 'after', settleMs: 10_000_000 },
                connectTrigger: { kind: 'presence', memberCount: 0, fallbackMs: -5 }
            },
            topology: { debounceWindowMs: 999_999, maxReplanWaitMs: 999_999_999 }
        });

        expect(policy.establishment.planTrigger).toEqual({
            kind: 'after',
            settleMs: MAX_GROUP_STAGE_TRIGGER_DELAY_MS
        });
        expect(policy.establishment.connectTrigger).toEqual({
            kind: 'presence',
            memberCount: 1,
            fallbackMs: 0
        });
        expect(policy.topology.debounceWindowMs).toBe(MAX_GROUP_TOPOLOGY_DEBOUNCE_WINDOW_MS);
        expect(policy.topology.maxReplanWaitMs).toBe(MAX_GROUP_TOPOLOGY_REPLAN_WAIT_MS);
    });

    it.each([
        { field: 'above one', input: 1.5, expected: 1 },
        { field: 'below zero', input: -0.5, expected: 0 },
        { field: 'not a number', input: Number.NaN, expected: 0 }
    ])('clamps a rate $field', ({ input, expected }) => {
        const policy = toNormalizedGroupLifecyclePolicy({
            activation: { successRate: input }
        });

        expect(policy.activation.successRate).toBe(expected);
    });

    it('clamps integer knobs to their server bounds', () => {
        const policy = toNormalizedGroupLifecyclePolicy({
            manager: { count: 9_999 },
            activation: { deadlineMs: 60 * 60 * 1000 }
        });

        expect(policy.manager.count).toBe(MAX_GROUP_MANAGERS);
        expect(policy.activation.deadlineMs).toBe(MAX_GROUP_FORMATION_DEADLINE_MS);
    });

    // null and undefined mean different things here: undefined defers to the
    // preset, null explicitly clears the constraint. Treating them alike would
    // make a capacity limit impossible to remove.
    it('separates an omitted constraint from an explicitly cleared one', () => {
        const inherited = toNormalizedGroupLifecyclePolicy({ preset: 'drop-in-social' });
        const cleared = toNormalizedGroupLifecyclePolicy({
            preset: 'drop-in-social',
            admission: { untilMemberCount: null }
        });

        expect(inherited.admission.untilMemberCount).toBe(50);
        expect(cleared.admission.untilMemberCount).toBeNull();
    });
});

describe('group lifecycle policy validation', () => {
    // The combination the design document allowed and no clamp can catch:
    // nobody is ever able to start establishment, so the group holds in
    // FORMING for its whole life.
    it('rejects a manager initiator with no manager selection', () => {
        const policy = toNormalizedGroupLifecyclePolicy({
            manager: { selection: 'none' },
            initiator: 'manager'
        });

        expect(toIssueCodes(policy)).toContain('manager-initiator-without-manager');
    });

    // The combination the earlier contract accepted silently: server-auto
    // denies every principal, so a manual trigger on a phased boundary is a
    // permanently stuck group.
    it('rejects a phased server-auto policy with a manual trigger', () => {
        const policy = toNormalizedGroupLifecyclePolicy({
            preset: 'managed',
            initiator: 'server-auto'
        });

        expect(toIssueCodes(policy)).toContain('server-auto-requires-automatic-trigger');
    });

    it('accepts a phased server-auto policy whose boundaries are all automatic', () => {
        const policy = toNormalizedGroupLifecyclePolicy({
            formation: 'phased',
            initiator: 'server-auto',
            activation: { mode: 'threshold', successRate: 0.8, minimumViableRate: 0.5 }
        });

        expect(toIssueCodes(policy)).toHaveLength(0);
    });

    it('rejects a phased server-auto policy with manual activation', () => {
        const policy = toNormalizedGroupLifecyclePolicy({
            formation: 'phased',
            initiator: 'server-auto',
            activation: { mode: 'manual' }
        });

        expect(toIssueCodes(policy)).toContain('server-auto-requires-automatic-activation');
    });

    it('rejects commanded replanning under server-auto', () => {
        const policy = toNormalizedGroupLifecyclePolicy({
            initiator: 'server-auto',
            topology: { replanning: 'commanded' }
        });

        expect(toIssueCodes(policy)).toContain('server-auto-cannot-command-replanning');
    });

    it('rejects a debounce window above the maximum wait', () => {
        const policy = toNormalizedGroupLifecyclePolicy({
            topology: { debounceWindowMs: 6_000, maxReplanWaitMs: 1_000 }
        });

        expect(toIssueCodes(policy)).toContain('replan-window-exceeds-maximum-wait');
    });

    // The slice-5 sibling deadlock: nobody could ever grant a parked join
    // (plan decision 5.3). Transient zero-manager states stay legal; only
    // the permanently granterless combination is invalid.
    it('rejects manager-approval admission with no manager selection', () => {
        const policy = toNormalizedGroupLifecyclePolicy({
            manager: { selection: 'none' },
            admission: { mode: 'manager-approval' }
        });

        expect(toIssueCodes(policy)).toContain('manager-approval-without-manager');
        expect(toIssueCodes(toNormalizedGroupLifecyclePolicy({ preset: 'managed' })))
            .toHaveLength(0);
    });

    it('rejects a floor above the success rate', () => {
        const policy = toNormalizedGroupLifecyclePolicy({
            activation: { mode: 'threshold', successRate: 0.5, minimumViableRate: 0.9 }
        });

        expect(toIssueCodes(policy)).toContain('viable-rate-above-success-rate');
    });

    it.each([
        {
            label: 'a threshold mode with no rate',
            input: { mode: 'threshold' as const, successRate: 0, minimumViableRate: 0 },
            code: 'threshold-mode-requires-positive-rate' as const
        },
        {
            label: 'a deadline mode with no deadline',
            input: { mode: 'deadline' as const, deadlineMs: 0 },
            code: 'deadline-mode-requires-positive-deadline' as const
        }
    ])('rejects $label', ({ input, code }) => {
        expect(toIssueCodes(toNormalizedGroupLifecyclePolicy({ activation: input })))
            .toContain(code);
    });

    it('rejects assigned selection without principals', () => {
        const policy = toNormalizedGroupLifecyclePolicy({
            manager: { selection: 'assigned', assignedPrincipalIds: [] }
        });

        expect(toIssueCodes(policy)).toContain('assigned-selection-requires-principals');
    });

    it('rejects more managers than assigned principals', () => {
        const policy = toNormalizedGroupLifecyclePolicy({
            manager: { selection: 'assigned', assignedPrincipalIds: ['a'], count: 2 }
        });

        expect(toIssueCodes(policy)).toContain('manager-count-exceeds-assigned-principals');
    });

    // The field exists so the intent can be expressed and answered rather than
    // silently accepted and ignored; the ledger it selects is not built.
    it('rejects strict confirmation as unsupported', () => {
        const policy = toNormalizedGroupLifecyclePolicy({
            activation: { strictConfirmation: true }
        });

        expect(toIssueCodes(policy)).toContain('strict-confirmation-unsupported');
    });

    // A caller should be able to fix one policy document once, rather than
    // resubmitting to discover the next problem.
    it('reports every issue rather than stopping at the first', () => {
        const policy = toNormalizedGroupLifecyclePolicy({
            manager: { selection: 'none' },
            initiator: 'manager',
            activation: {
                mode: 'threshold',
                successRate: 0,
                minimumViableRate: 0,
                strictConfirmation: true
            }
        });

        expect(toIssueCodes(policy)).toEqual(
            expect.arrayContaining([
                'manager-initiator-without-manager',
                'threshold-mode-requires-positive-rate',
                'strict-confirmation-unsupported'
            ])
        );
    });

    it('returns the policy on the right when it is coherent', () => {
        const policy = createDefaultGroupLifecyclePolicy();

        expect(validateGroupLifecyclePolicy(policy).right).toEqual(policy);
    });
});
