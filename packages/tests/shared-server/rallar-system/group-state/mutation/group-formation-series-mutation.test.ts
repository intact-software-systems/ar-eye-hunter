import { describe, expect, it } from 'vitest';

import { APP_OUTBOX_FORMATION_TIMER_TOPIC } from '@shared-server/rallar-system/group-state/formation-timer-outbox-entry.ts';
import { computeLifecycleTransition } from '@shared-server/rallar-system/group-state/mutation/aggregate/compute-lifecycle-transition.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-state/policy/group-policy-result.ts';
import type { GroupPolicyDenied } from '@shared/api/group-policy-types.ts';
import type { Group } from '@shared/api/group-types.ts';

import { createGroupAuthorityFacts, createGroupAuthorityRead, transitionCommand } from './group-mutation-test-runtime.ts';

/**
 * `start` opens a formation series from the clean slate (product decisions
 * 35/37). Dark -- no route, no producer -- until slice 8 mounts it. Its partner
 * `reset` lands in slice 6c.
 */
describe('group formation series computation', () => {
    it('starts a new series from dormant and advances the epoch', () => {
        const computed = computeGroupMutation({
            command: transitionCommand('startGroupFormation'),
            read: createGroupAuthorityRead({ lifecycleState: 'dormant', formationEpoch: 4 }),
            facts: createGroupAuthorityFacts()
        });

        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        const written = computed.guard.value as Group;
        expect(written.lifecycleState).toBe('forming');
        expect(written.formationEpoch).toBe(5);
        // Opening a series neither spends nor clears the budget, and `forming`
        // consumes no deadline, so the write arms no timer.
        expect(written.formationAttemptCount).toBe(0);
        expect(computed.outboxEntries.map((entry) => entry.key.topicId))
            .not.toContain(APP_OUTBOX_FORMATION_TIMER_TOPIC);
    });

    it('denies start once the attempt series is spent', () => {
        // The optimistic preset allows one attempt, so a dormant group holding
        // one has spent the series (product decision 37).
        const denial = expectPolicyDenial(() =>
            computeGroupMutation({
                command: transitionCommand('startGroupFormation'),
                read: createGroupAuthorityRead({
                    lifecycleState: 'dormant',
                    formationAttemptCount: 1
                }, { policy: 'optimistic' }),
                facts: createGroupAuthorityFacts()
            })
        );

        expect(denial.code).toBe('formation-attempts-exhausted');
    });

    /**
     * Decision 37 calls exhaustion terminal for automation, so the budget is a
     * precondition of the transition rather than a clause of the initiator
     * policy -- internal authority skips the policy entirely. Latent today:
     * `validateGroupMutationAuthority` still refuses `startGroupFormation`
     * under criterion authority, so this is asserted at the compute that owns
     * the invariant, which is where the later slices open that arm.
     */
    it('denies a spent series on the criterion path, which answers to no initiator policy', () => {
        const denial = expectPolicyDenial(() =>
            computeLifecycleTransition(
                transitionCommand('startGroupFormation'),
                createGroupAuthorityRead({
                    lifecycleState: 'dormant',
                    formationAttemptCount: 1
                }, { policy: 'optimistic' }),
                { ...createGroupAuthorityFacts(), internalAuthority: 'formation-criterion' }
            )
        );

        expect(denial.code).toBe('formation-attempts-exhausted');
    });

    // The state machine answers first: `start` is illegal outside `dormant`
    // whatever the budget holds, so an exhausted series in `forming` reports
    // the transition rather than the budget.
    it('reports an illegal transition ahead of a spent budget', () => {
        const denial = expectPolicyDenial(() =>
            computeGroupMutation({
                command: transitionCommand('startGroupFormation'),
                read: createGroupAuthorityRead({
                    lifecycleState: 'forming',
                    formationAttemptCount: 1
                }, { policy: 'optimistic' }),
                facts: createGroupAuthorityFacts()
            })
        );

        expect(denial.code).toBe('lifecycle-transition-invalid');
    });
});

function expectPolicyDenial(run: () => void): GroupPolicyDenied {
    try {
        run();
    }
    catch (error) {
        if (error instanceof GroupPolicyDeniedError) {
            return error.denial;
        }
        throw error;
    }
    throw new Error('Expected the command to be denied, but it was allowed');
}
