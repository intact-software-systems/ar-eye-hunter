import { describe, expect, it } from 'vitest';

import type { GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { GROUP_MUTATION_INTERNAL_AUTHORITY_MODES } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { GROUP_LIFECYCLE_STATES } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupPolicyDenied } from '@shared/api/group-policy-types.ts';
import type { Group } from '@shared/api/group-types.ts';
import { GROUP_PRESENCE_SUMMARY_TOPIC } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';

import { createGroupAuthorityAuditStamp, createGroupAuthorityFacts, createGroupAuthorityRead, groupRef } from './group-mutation-test-runtime.ts';

describe('group transport mutation computation', () => {
    it('pauses a flowing group by halting transport alone', () => {
        const computed = computeGroupMutation({
            command: transportCommand('pauseGroupTransport'),
            read: createGroupAuthorityRead({
                transportState: 'flowing',
                lifecycleState: 'active',
                formationEpoch: 3
            }),
            facts: createGroupAuthorityFacts()
        });

        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        const written = computed.guard.value as Group;
        expect(written.transportState).toBe('halted');
        // Decision 25's payoff: the halt never touches the routing plane, so
        // manager election and every epoch-keyed timer survive it.
        expect(written.lifecycleState).toBe('active');
        expect(written.formationEpoch).toBe(3);
        expect(written.formationElectorate).toEqual(['alice']);
        expect(written.snapshotVersion).toBe(2);
    });

    it('resumes a halted group by restoring flow', () => {
        const computed = computeGroupMutation({
            command: transportCommand('resumeGroupTransport'),
            read: createGroupAuthorityRead({ transportState: 'halted', lifecycleState: 'reconnecting' }),
            facts: createGroupAuthorityFacts()
        });

        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        expect((computed.guard.value as Group).transportState).toBe('flowing');
        expect((computed.guard.value as Group).lifecycleState).toBe('reconnecting');
    });

    it.each([
        ['pauseGroupTransport' as const, 'halted' as const],
        ['resumeGroupTransport' as const, 'flowing' as const]
    ])('answers no-op when %s finds the valve already at %s', (operation, transportState) => {
        const computed = computeGroupMutation({
            command: transportCommand(operation),
            read: createGroupAuthorityRead({ transportState }),
            facts: createGroupAuthorityFacts()
        });

        expect(computed.outcome).toBe('no-op');
        if (computed.outcome !== 'no-op') {
            return;
        }
        expect(computed.receipt.eventId).toBe(null);
        expect(computed.receipt.outboxIds).toEqual([]);
        // The stored snapshot version is reported unchanged, so no delta ships.
        expect(computed.receipt.snapshotVersion).toBe(1);
    });

    it('arms no formation timer: the only outbox entry is the presence summary', () => {
        const computed = computeGroupMutation({
            command: transportCommand('pauseGroupTransport'),
            read: createGroupAuthorityRead({
                transportState: 'flowing',
                lifecycleState: 'connecting',
                establishmentStartedAtEpochMs: 1_500
            }),
            facts: createGroupAuthorityFacts()
        });

        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        expect(computed.outboxWrites.map((write) => write.entry.key.topicId)).toEqual([
            GROUP_PRESENCE_SUMMARY_TOPIC
        ]);
        // The establishment clock the connecting stage started is untouched,
        // so the deadline timer armed by `connect` still measures its stage.
        expect((computed.guard.value as Group).establishmentStartedAtEpochMs).toBe(1_500);
        expect(computed.acceptedLayoutPromotion).toBe(null);
        expect(computed.plannedLayoutFence).toBe(null);
    });

    // The valve is orthogonal to the stage (decision 25), so it has no
    // transition-table row and is legal wherever the group is: a new stage
    // joins this proof by joining the state registry.
    it.each(GROUP_LIFECYCLE_STATES)('halts a flowing group in the %s stage', (lifecycleState) => {
        const computed = computeGroupMutation({
            command: transportCommand('pauseGroupTransport'),
            read: createGroupAuthorityRead({ transportState: 'flowing', lifecycleState }),
            facts: createGroupAuthorityFacts()
        });

        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        expect((computed.guard.value as Group).transportState).toBe('halted');
        expect((computed.guard.value as Group).lifecycleState).toBe(lifecycleState);
    });

    // Product decision 12: the valve answers to the same initiator policy as
    // the seven other application-facing group-authority commands.
    it('denies the valve to every principal under a server-auto initiator', () => {
        const denial = readTransportDenial(
            computeGroupMutation({
                command: transportCommand('pauseGroupTransport'),
                read: createGroupAuthorityRead({ transportState: 'flowing' }, { policy: 'server-auto' }),
                facts: createGroupAuthorityFacts()
            })
        );

        expect(denial.code).toBe('forbidden-role');
        expect(denial.message).toContain('server-initiated');
    });

    // The roster must carry the creator too, or the policy resolves no manager
    // at all and the denial would come from `lifecycle-manager-unavailable`
    // without ever reaching the membership question this test is about.
    it('denies the valve to an active member who is not the resolved manager', () => {
        const denial = readTransportDenial(
            computeGroupMutation({
                command: transportCommand('resumeGroupTransport', 'bob'),
                read: createGroupAuthorityRead(
                    { transportState: 'halted' },
                    {
                        policy: 'managed',
                        actorPrincipalId: 'bob',
                        activeMemberPrincipalIds: ['alice', 'bob']
                    }
                ),
                facts: createGroupAuthorityFacts('bob')
            })
        );

        expect(denial.code).toBe('forbidden-role');
        expect(denial.message).toContain('manager');
    });

    it('allows the valve to the manager the same policy resolves', () => {
        const computed = computeGroupMutation({
            command: transportCommand('resumeGroupTransport'),
            read: createGroupAuthorityRead({ transportState: 'halted' }, { policy: 'managed' }),
            facts: createGroupAuthorityFacts()
        });

        expect(computed.outcome).toBe('write');
    });

    it('denies the valve to an actor who is not an active member', () => {
        const denial = readTransportDenial(
            computeGroupMutation({
                command: transportCommand('pauseGroupTransport'),
                read: createGroupAuthorityRead({ transportState: 'flowing' }, { actorIsMember: false }),
                facts: createGroupAuthorityFacts()
            })
        );

        expect(denial.code).toBe('member-not-active');
    });

    // The valve inherits the aggregate's own liveness rule: an archived or
    // deleted group is not commandable at all.
    it.each(['archived' as const, 'deleted' as const])(
        'denies the valve on a %s group',
        (status) => {
            const denial = readTransportDenial(
                computeGroupMutation({
                    command: transportCommand('pauseGroupTransport'),
                    read: createGroupAuthorityRead({
                        transportState: 'flowing',
                        status,
                        [status]: createGroupAuthorityAuditStamp(1_500, 'alice')
                    }),
                    facts: createGroupAuthorityFacts()
                })
            );

            expect(denial.code).toBe(`group-${status}`);
        }
    );

    it('fails closed on an unreadable stored policy instead of reading it as permissive', () => {
        const computed = computeGroupMutation({
            command: transportCommand('pauseGroupTransport'),
            read: createGroupAuthorityRead({ transportState: 'flowing' }, { policy: 'corrupt' }),
            facts: createGroupAuthorityFacts()
        });

        expect(computed.outcome).toBe('rejected');
        if (computed.outcome !== 'rejected') {
            return;
        }
        expect(computed.rejectionCode).toBe('group-mutation-rejected');
        expect(computed.receipt.rejection).toContain('Group lifecycle policy is unreadable');
    });

    // Decision 25: the valve is never automatic. No internal authority mode
    // admits it, so every mode refuses before compute is reached.
    it.each(
        GROUP_MUTATION_INTERNAL_AUTHORITY_MODES.filter((mode) => mode !== 'none')
    )('refuses a transport command carried by %s authority', (internalAuthority) => {
        expect(() =>
            computeGroupMutation({
                command: internalTransportCommand(),
                read: createGroupAuthorityRead({ transportState: 'flowing' }),
                facts: { ...createGroupAuthorityFacts(), internalAuthority, authenticatedAuthority: null }
            })
        ).toThrowError(TypeError);
    });
});

function readTransportDenial(computed: ReturnType<typeof computeGroupMutation>): GroupPolicyDenied {
    expect(computed.outcome).toBe('rejected');
    if (computed.outcome !== 'rejected' || computed.rejectionCode !== 'group-policy-denied') {
        throw new Error('Expected a typed policy rejection');
    }
    expect(computed.receipt).toMatchObject({ eventId: null, outboxIds: [] });
    return computed.policyDenial;
}

function internalTransportCommand(): GroupMutationCommand {
    return {
        operation: 'pauseGroupTransport',
        aggregateRef: groupRef('pure-room'),
        commandId: 'internal-transport-command',
        requestId: 'internal-transport-command',
        input: {
            actorPrincipalId: null,
            actorSessionId: null,
            reason: null,
            traceId: null
        }
    } as GroupMutationCommand;
}

function transportCommand(
    operation: 'pauseGroupTransport' | 'resumeGroupTransport',
    actorPrincipalId = 'alice'
): GroupMutationCommand {
    return {
        operation,
        aggregateRef: groupRef('pure-room'),
        commandId: 'transport-command',
        requestId: 'transport-command',
        input: {
            actorPrincipalId,
            actorSessionId: `${actorPrincipalId}-session`,
            reason: null,
            traceId: null
        }
    } as GroupMutationCommand;
}
