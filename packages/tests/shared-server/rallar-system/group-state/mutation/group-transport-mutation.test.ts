import { describe, expect, it } from 'vitest';

import type {
    GroupMutationCommand,
    GroupMutationFacts,
    GroupMutationRead
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { GROUP_MUTATION_INTERNAL_AUTHORITY_MODES } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-state/policy/group-policy-result.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import { GROUP_LIFECYCLE_STATES } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { AuditStamp, Group } from '@shared/api/group-types.ts';
import { GROUP_PRESENCE_SUMMARY_TOPIC } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { createTestGroup } from '../../../../create-test-group.ts';

import { groupMemberStorageKey, groupRef, groupStorageKey, storedEntry } from './group-mutation-test-runtime.ts';

describe('group transport mutation computation', () => {
    it('pauses a flowing group by halting transport alone', () => {
        const computed = computeGroupMutation({
            command: transportCommand('pauseGroupTransport'),
            read: transportRead({
                transportState: 'flowing',
                lifecycleState: 'active',
                formationEpoch: 3
            }),
            facts: transportFacts()
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
            read: transportRead({ transportState: 'halted', lifecycleState: 'reconnecting' }),
            facts: transportFacts()
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
            read: transportRead({ transportState }),
            facts: transportFacts()
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
            read: transportRead({
                transportState: 'flowing',
                lifecycleState: 'connecting',
                establishmentStartedAtEpochMs: 1_500
            }),
            facts: transportFacts()
        });

        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        expect(computed.outboxEntries.map((entry) => entry.key.topicId)).toEqual([
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
            read: transportRead({ transportState: 'flowing', lifecycleState }),
            facts: transportFacts()
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
        expect(() =>
            computeGroupMutation({
                command: transportCommand('pauseGroupTransport'),
                read: transportRead({ transportState: 'flowing' }, { policy: 'server-auto' }),
                facts: transportFacts()
            })
        ).toThrowError(GroupPolicyDeniedError);
    });

    it('denies the valve to a non-manager under a manager initiator', () => {
        expect(() =>
            computeGroupMutation({
                command: transportCommand('resumeGroupTransport', 'bob'),
                read: transportRead(
                    { transportState: 'halted' },
                    { policy: 'managed', actorPrincipalId: 'bob' }
                ),
                facts: transportFacts('bob')
            })
        ).toThrowError(GroupPolicyDeniedError);
    });

    it('allows the valve to the manager the same policy resolves', () => {
        const computed = computeGroupMutation({
            command: transportCommand('resumeGroupTransport'),
            read: transportRead({ transportState: 'halted' }, { policy: 'managed' }),
            facts: transportFacts()
        });

        expect(computed.outcome).toBe('write');
    });

    it('denies the valve to an actor who is not an active member', () => {
        expect(() =>
            computeGroupMutation({
                command: transportCommand('pauseGroupTransport'),
                read: transportRead({ transportState: 'flowing' }, { actorIsMember: false }),
                facts: transportFacts()
            })
        ).toThrowError(GroupPolicyDeniedError);
    });

    it('fails closed on an unreadable stored policy instead of reading it as permissive', () => {
        const computed = computeGroupMutation({
            command: transportCommand('pauseGroupTransport'),
            read: transportRead({ transportState: 'flowing' }, { policy: 'corrupt' }),
            facts: transportFacts()
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
                read: transportRead({ transportState: 'flowing' }),
                facts: { ...transportFacts(), internalAuthority, authenticatedAuthority: null }
            })
        ).toThrowError(TypeError);
    });
});

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
    } as unknown as GroupMutationCommand;
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
    } as unknown as GroupMutationCommand;
}

interface TransportReadOptions {
    readonly policy?: 'absent' | 'corrupt' | 'optimistic' | 'managed' | 'server-auto';
    readonly actorPrincipalId?: string;
    readonly actorIsMember?: boolean;
}

function transportRead(
    groupOverrides: Partial<Group>,
    options: TransportReadOptions = {}
): GroupMutationRead {
    const actorPrincipalId = options.actorPrincipalId ?? 'alice';
    const audit = transportAuditStamp(1_000, actorPrincipalId);
    const group = createTestGroup({ ...groupRef('pure-room'), ...groupOverrides });
    const actorMember = {
        ...groupRef('pure-room'),
        principalId: actorPrincipalId,
        role: 'member' as const,
        status: 'active' as const,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        left: null,
        removed: null,
        banned: null,
        joined: audit,
        updated: audit
    };
    const requested = options.policy ?? 'absent';
    const lifecyclePolicy = requested === 'corrupt'
        ? { status: 'corrupt' as const, reason: 'stored policy is not an object' }
        : requested === 'absent'
        ? { status: 'absent' as const }
        : {
            status: 'present' as const,
            policy: requested === 'server-auto'
                ? {
                    ...resolveGroupLifecyclePolicyPreset('optimistic'),
                    initiator: 'server-auto' as const
                }
                : resolveGroupLifecyclePolicyPreset(requested)
        };
    return {
        idempotency: null,
        group: storedEntry(groupStorageKey(), group),
        expiredGroupEntry: null,
        actorMember: options.actorIsMember === false ? null : actorMember,
        targetMember: null,
        authorityMember: null,
        directorMember: null,
        actorMemberEntry: options.actorIsMember === false
            ? null
            : storedEntry(groupMemberStorageKey(actorPrincipalId), actorMember),
        targetMemberEntry: null,
        authorityMemberEntry: null,
        directorMemberEntry: null,
        targetPresence: null,
        expiredTargetPresenceEntry: null,
        targetAdmission: null,
        authorityAdmission: null,
        directorAdmission: null,
        authorityPresenceSessions: [],
        authorityPresenceSessionEntries: [],
        presenceSummary: null,
        lifecyclePolicy,
        activeMemberPrincipalIds: options.actorIsMember === false ? [] : [actorPrincipalId],
        plannedLayoutRow: null,
        acceptedLayoutRow: null
    } as GroupMutationRead;
}

function transportFacts(principalId = 'alice'): GroupMutationFacts {
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
        authenticatedAuthority: {
            principalId,
            sessionId: `${principalId}-session`
        }
    };
}

function transportAuditStamp(atEpochMs: number, principalId: string): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId },
        reason: null,
        traceId: null,
        requestId: 'seed'
    };
}
