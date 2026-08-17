import { describe, expect, it } from 'vitest';
import {
    GROUP_LIFECYCLE_POLICY_PRESET_NAMES,
    type GroupLifecyclePolicy,
    type GroupLifecyclePolicyIssueCode,
} from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import {
    createDefaultGroupLifecyclePolicy,
    resolveGroupLifecyclePolicyPreset,
} from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import {
    MAX_GROUP_FORMATION_DEADLINE_MS,
    MAX_GROUP_MANAGERS,
    toNormalizedGroupLifecyclePolicy,
} from '@shared/api/group-lifecycle/to-normalized-group-lifecycle-policy.ts';
import { validateGroupLifecyclePolicy } from '@shared/api/group-lifecycle/validate-group-lifecycle-policy.ts';

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
});

describe('group lifecycle policy normalization', () => {
    it('layers sparse input over the named preset', () => {
        const policy = toNormalizedGroupLifecyclePolicy({
            preset: 'managed',
            admission: { mode: 'closed' },
        });

        expect(policy.admission.mode).toBe('closed');
        expect(policy.formation).toBe('phased');
        expect(policy.establishment.initiator).toBe('manager');
    });

    it.each([
        { field: 'above one', input: 1.5, expected: 1 },
        { field: 'below zero', input: -0.5, expected: 0 },
        { field: 'not a number', input: Number.NaN, expected: 0 },
    ])('clamps a rate $field', ({ input, expected }) => {
        const policy = toNormalizedGroupLifecyclePolicy({
            activation: { successRate: input },
        });

        expect(policy.activation.successRate).toBe(expected);
    });

    it('clamps integer knobs to their server bounds', () => {
        const policy = toNormalizedGroupLifecyclePolicy({
            manager: { count: 9_999 },
            activation: { deadlineMs: 60 * 60 * 1000 },
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
            admission: { untilMemberCount: null },
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
            establishment: { initiator: 'manager' },
        });

        expect(toIssueCodes(policy)).toContain('manager-initiator-without-manager');
    });

    it('rejects a floor above the success rate', () => {
        const policy = toNormalizedGroupLifecyclePolicy({
            activation: { mode: 'threshold', successRate: 0.5, minimumViableRate: 0.9 },
        });

        expect(toIssueCodes(policy)).toContain('viable-rate-above-success-rate');
    });

    it.each([
        {
            label: 'a threshold mode with no rate',
            input: { mode: 'threshold' as const, successRate: 0, minimumViableRate: 0 },
            code: 'threshold-mode-requires-positive-rate' as const,
        },
        {
            label: 'a deadline mode with no deadline',
            input: { mode: 'deadline' as const, deadlineMs: 0 },
            code: 'deadline-mode-requires-positive-deadline' as const,
        },
    ])('rejects $label', ({ input, code }) => {
        expect(toIssueCodes(toNormalizedGroupLifecyclePolicy({ activation: input })))
            .toContain(code);
    });

    it('rejects assigned selection without principals', () => {
        const policy = toNormalizedGroupLifecyclePolicy({
            manager: { selection: 'assigned', assignedPrincipalIds: [] },
        });

        expect(toIssueCodes(policy)).toContain('assigned-selection-requires-principals');
    });

    it('rejects more managers than assigned principals', () => {
        const policy = toNormalizedGroupLifecyclePolicy({
            manager: { selection: 'assigned', assignedPrincipalIds: ['a'], count: 2 },
        });

        expect(toIssueCodes(policy)).toContain('manager-count-exceeds-assigned-principals');
    });

    // The field exists so the intent can be expressed and answered rather than
    // silently accepted and ignored; the ledger it selects is not built.
    it('rejects strict confirmation as unsupported', () => {
        const policy = toNormalizedGroupLifecyclePolicy({
            activation: { strictConfirmation: true },
        });

        expect(toIssueCodes(policy)).toContain('strict-confirmation-unsupported');
    });

    // A caller should be able to fix one policy document once, rather than
    // resubmitting to discover the next problem.
    it('reports every issue rather than stopping at the first', () => {
        const policy = toNormalizedGroupLifecyclePolicy({
            manager: { selection: 'none' },
            establishment: { initiator: 'manager' },
            activation: {
                mode: 'threshold',
                successRate: 0,
                minimumViableRate: 0,
                strictConfirmation: true,
            },
        });

        expect(toIssueCodes(policy)).toEqual(
            expect.arrayContaining([
                'manager-initiator-without-manager',
                'threshold-mode-requires-positive-rate',
                'strict-confirmation-unsupported',
            ]),
        );
    });

    it('returns the policy on the right when it is coherent', () => {
        const policy = createDefaultGroupLifecyclePolicy();

        expect(validateGroupLifecyclePolicy(policy).right).toEqual(policy);
    });
});
