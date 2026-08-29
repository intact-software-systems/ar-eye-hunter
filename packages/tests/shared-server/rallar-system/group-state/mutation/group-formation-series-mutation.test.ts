import { describe, expect, it } from 'vitest';

import type { GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-state/policy/group-policy-result.ts';
import type { Group } from '@shared/api/group-types.ts';

import { createGroupAuthorityFacts, createGroupAuthorityRead, groupRef } from './group-mutation-test-runtime.ts';

/**
 * `start` opens a formation series from the clean slate (product decisions
 * 35/37). Dark — no route, no producer — until slice 8 mounts it. Its partner
 * `reset` lands in slice 6c, which owns the topology retirement semantics.
 */
describe('group formation series computation', () => {
    it('starts a new series from dormant and advances the epoch', () => {
        const computed = computeGroupMutation({
            command: seriesCommand('startGroupFormation'),
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
    });

    // Decision 37: exhaustion is terminal for automation, and only an explicit
    // `reset` clears the series. The optimistic preset allows one attempt.
    it('denies start while the attempt series is exhausted', () => {
        expect(() =>
            computeGroupMutation({
                command: seriesCommand('startGroupFormation'),
                read: createGroupAuthorityRead({
                    lifecycleState: 'dormant',
                    formationAttemptCount: 1
                }, { policy: 'optimistic' }),
                facts: createGroupAuthorityFacts()
            })
        ).toThrowError(GroupPolicyDeniedError);
    });

    it('starts while the series still has budget', () => {
        const computed = computeGroupMutation({
            command: seriesCommand('startGroupFormation'),
            read: createGroupAuthorityRead({
                lifecycleState: 'dormant',
                formationAttemptCount: 0
            }, { policy: 'optimistic' }),
            facts: createGroupAuthorityFacts()
        });

        expect(computed.outcome).toBe('write');
    });
});

function seriesCommand(
    operation: 'startGroupFormation',
    actorPrincipalId = 'alice'
): GroupMutationCommand {
    return {
        operation,
        aggregateRef: groupRef('pure-room'),
        commandId: 'series-command',
        requestId: 'series-command',
        input: {
            actorPrincipalId,
            actorSessionId: `${actorPrincipalId}-session`,
            reason: null,
            traceId: null,
            expectedFormationEpoch: null
        }
    } as GroupMutationCommand;
}
