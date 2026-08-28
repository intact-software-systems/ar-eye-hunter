import { describe, expect, it } from 'vitest';

import {
    resolveGroupAuthorityPolicy,
    toCorruptPolicyRejection
} from '@shared-server/rallar-system/group-state/mutation/aggregate/resolve-group-authority-policy.ts';
import type {
    GroupMutationCommand,
    GroupMutationFacts,
    GroupMutationRead
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';

import { createTestGroup } from '../../../../create-test-group.ts';
import { groupRef, groupStorageKey, storedEntry } from './group-mutation-test-runtime.ts';

// The three group-authority computes share this reader, so its arms are
// pinned here rather than only through whichever compute happens to call it.
describe('group authority policy resolution', () => {
    it('resolves an absent stored policy to the default preset', () => {
        const resolution = resolveGroupAuthorityPolicy(policyRead({ status: 'absent' }));

        expect(resolution).toEqual({
            status: 'resolved',
            policy: resolveGroupLifecyclePolicyPreset('optimistic')
        });
    });

    it('resolves a stored policy to exactly what is stored', () => {
        const policy = resolveGroupLifecyclePolicyPreset('managed');
        const resolution = resolveGroupAuthorityPolicy(policyRead({ status: 'present', policy }));

        expect(resolution).toEqual({ status: 'resolved', policy });
    });

    // Fail closed: an unreadable document must never resolve to a permissive
    // default, so it surfaces as a value the caller rejects with.
    it('surfaces an unreadable stored policy as corrupt rather than as a policy', () => {
        const resolution = resolveGroupAuthorityPolicy(
            policyRead({ status: 'corrupt', reason: 'stored policy is not an object' })
        );

        expect(resolution).toEqual({
            status: 'corrupt',
            reason: 'stored policy is not an object'
        });
    });

    // The read path and its validator both key on the same predicate, so a
    // missing read is a programmer invariant, never a caller's mistake.
    it('throws when the read that both the loader and the validator gate on is missing', () => {
        expect(() => resolveGroupAuthorityPolicy(policyRead(null))).toThrowError(
            'Group authority compute requires the policy read'
        );
    });

    it('rejects a corrupt policy with the shared code and reason', () => {
        const computed = toCorruptPolicyRejection({
            command: policyCommand(),
            read: policyRead({ status: 'corrupt', reason: 'unreadable' }),
            facts: policyFacts(),
            reason: 'unreadable'
        });

        expect(computed.outcome).toBe('rejected');
        if (computed.outcome !== 'rejected') {
            return;
        }
        expect(computed.rejectionCode).toBe('group-mutation-rejected');
        expect(computed.receipt.rejection).toBe('Group lifecycle policy is unreadable: unreadable');
    });
});

function policyRead(lifecyclePolicy: GroupMutationRead['lifecyclePolicy']): GroupMutationRead {
    return {
        group: storedEntry(groupStorageKey(), createTestGroup(groupRef('pure-room'))),
        presenceSummary: null,
        lifecyclePolicy
    } as GroupMutationRead;
}

function policyCommand(): GroupMutationCommand {
    return {
        operation: 'pauseGroupTransport',
        aggregateRef: groupRef('pure-room'),
        commandId: 'policy-command',
        requestId: 'policy-command',
        input: {
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            reason: null,
            traceId: null
        }
    } as GroupMutationCommand;
}

function policyFacts(): GroupMutationFacts {
    return {
        nowEpochMs: 2_000,
        expireAtEpochMs: 253_402_300_799_999,
        serviceId: 'group-service',
        eventId: 'event-1',
        commandHash: `sha256:${'a'.repeat(64)}`,
        attemptCount: 1,
        resolvedJoinCode: null,
        joinCodeVerifier: null,
        internalAuthority: 'none',
        authenticatedAuthority: { principalId: 'alice', sessionId: 'alice-session' }
    };
}
