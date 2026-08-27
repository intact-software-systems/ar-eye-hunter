import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { describe, expect, it } from 'vitest';

import type {
    GroupMutationCommand,
    GroupMutationFacts,
    GroupMutationRead
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-state/policy/group-policy-result.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { AuditStamp, Group } from '@shared/api/group-types.ts';
import { createTestGroup } from '../../../../create-test-group.ts';

import { groupMemberStorageKey, groupRef, groupStorageKey, storedEntry } from './group-mutation-test-runtime.ts';

describe('group lifecycle transition computation', () => {
    it('starts establishment from forming and advances the formation epoch', () => {
        const computed = computeGroupMutation({
            command: transitionCommand('startGroupEstablishment'),
            read: transitionRead({ lifecycleState: 'forming', formationEpoch: 2 }),
            facts: transitionFacts()
        });

        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        expect(computed.guard.kind).toBe('group');
        const written = computed.guard.value as Group;
        expect(written.lifecycleState).toBe('connecting');
        expect(written.formationEpoch).toBe(3);
        expect(written.snapshotVersion).toBe(2);
        expect(computed.event.eventType).toBe('group-updated');
    });

    it('pins the formation electorate to the roster read at every epoch advance', () => {
        const cases = [
            { operation: 'startGroupEstablishment', lifecycleState: 'forming' },
            { operation: 'activateGroup', lifecycleState: 'connecting' },
            { operation: 'reopenGroupEstablishment', lifecycleState: 'active' }
        ] as const;
        for (const { operation, lifecycleState } of cases) {
            const computed = computeGroupMutation({
                command: transitionCommand(operation),
                read: transitionRead({ lifecycleState }),
                facts: transitionFacts()
            });
            expect(computed.outcome).toBe('write');
            if (computed.outcome !== 'write') {
                continue;
            }
            // transitionRead loads the actor as the only active member.
            expect((computed.guard.value as Group).formationElectorate).toEqual(['alice']);
        }
    });

    it('activates from connecting and from reconfiguring', () => {
        for (const from of ['connecting', 'reconfiguring'] as const) {
            const computed = computeGroupMutation({
                command: transitionCommand('activateGroup'),
                read: transitionRead({ lifecycleState: from, formationEpoch: 1 }),
                facts: transitionFacts()
            });
            expect(computed.outcome).toBe('write');
            if (computed.outcome !== 'write') {
                continue;
            }
            const written = computed.guard.value as Group;
            expect(written.lifecycleState).toBe('active');
            expect(written.formationEpoch).toBe(2);
        }
    });

    it('reopens establishment only from active', () => {
        const computed = computeGroupMutation({
            command: transitionCommand('reopenGroupEstablishment'),
            read: transitionRead({ lifecycleState: 'active', formationEpoch: 4 }),
            facts: transitionFacts()
        });
        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        const written = computed.guard.value as Group;
        expect(written.lifecycleState).toBe('reconfiguring');
        expect(written.formationEpoch).toBe(5);
    });

    it('denies an illegal transition as a typed policy denial', () => {
        expect(() =>
            computeGroupMutation({
                command: transitionCommand('startGroupEstablishment'),
                read: transitionRead({ lifecycleState: 'active', formationEpoch: 1 }),
                facts: transitionFacts()
            })
        ).toThrowError(GroupPolicyDeniedError);
    });

    it('denies a non-manager under the managed policy', () => {
        const read = transitionRead(
            { lifecycleState: 'forming', formationEpoch: 0, ownerPrincipalId: 'owner-alice' },
            { policyStatus: 'managed', actorPrincipalId: 'bob' }
        );
        expect(() =>
            computeGroupMutation({
                command: transitionCommand('startGroupEstablishment', 'bob'),
                read,
                facts: transitionFacts('bob')
            })
        ).toThrowError(GroupPolicyDeniedError);
    });

    it('rejects on a corrupt stored policy instead of failing open', () => {
        const computed = computeGroupMutation({
            command: transitionCommand('startGroupEstablishment'),
            read: transitionRead({ lifecycleState: 'forming', formationEpoch: 0 }, { policyStatus: 'corrupt' }),
            facts: transitionFacts()
        });
        expect(computed.outcome).toBe('rejected');
    });

    it('fails formation with criterion authority: outcome, attempts, epoch, anchor', () => {
        const computed = computeGroupMutation({
            command: criterionCommand('failGroupFormation', {
                observedRate: 0.3,
                expectedFormationEpoch: 2,
                expectedLayout: PLANNED_LAYOUT
            }),
            read: criterionRead({
                lifecycleState: 'connecting',
                formationEpoch: 2,
                establishmentStartedAtEpochMs: 1_500,
                formationAttemptCount: 1
            }),
            facts: criterionFacts()
        });
        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        const written = computed.guard.value as Group;
        expect(written.lifecycleState).toBe('forming');
        expect(written.formationEpoch).toBe(3);
        expect(written.formationAttemptCount).toBe(2);
        expect(written.establishmentStartedAtEpochMs).toBe(null);
        expect(written.lastFormationOutcome).toEqual({
            outcome: 'below-floor',
            observedRate: 0.3,
            atEpochMs: 2_000,
            formationEpoch: 2
        });
    });

    // The causal fence: a stale petition is a typed rejection that computes
    // no write facts at all — never a wrong transition, never a silent no-op.
    it.each([
        {
            label: 'a stale epoch',
            expectedFormationEpoch: 1,
            expectedLayout: PLANNED_LAYOUT,
            planned: PLANNED_LAYOUT,
            rejection: /stale-epoch/
        },
        {
            label: 'a superseded planned layout',
            expectedFormationEpoch: 2,
            expectedLayout: { ...PLANNED_LAYOUT, version: 1 },
            planned: PLANNED_LAYOUT,
            rejection: /planned-layout-superseded/
        },
        {
            label: 'a missing planned row',
            expectedFormationEpoch: 2,
            expectedLayout: PLANNED_LAYOUT,
            planned: null,
            rejection: /no-planned-layout/
        }
    ])('fences $label without computing any write', (row) => {
        const computed = computeGroupMutation({
            command: criterionCommand('failGroupFormation', {
                observedRate: 0.3,
                expectedFormationEpoch: row.expectedFormationEpoch,
                expectedLayout: row.expectedLayout
            }),
            read: criterionRead(
                { lifecycleState: 'connecting', formationEpoch: 2 },
                row.planned
            ),
            facts: criterionFacts()
        });
        expect(computed.outcome).toBe('rejected');
        if (computed.outcome !== 'rejected') {
            return;
        }
        expect(computed.receipt.rejection).toMatch(row.rejection);
        expect(computed.receipt.eventId).toBeNull();
        expect(computed.receipt.outboxIds).toEqual([]);
        expect('guard' in computed).toBe(false);
        expect('outboxEntries' in computed).toBe(false);
    });

    it('rejects principal-commanded formation failure', () => {
        expect(() =>
            computeGroupMutation({
                command: transitionCommand('failGroupFormation' as never),
                read: transitionRead({ lifecycleState: 'connecting', formationEpoch: 1 }),
                facts: transitionFacts()
            })
        ).toThrowError(/criterion-commanded only/);
    });

    it('records the criterion outcome on internal activation', () => {
        for (
            const [degraded, outcome] of [
                [false, 'activated'],
                [true, 'activated-degraded']
            ] as const
        ) {
            const computed = computeGroupMutation({
                command: criterionCommand('activateGroup', {
                    observedRate: 0.97,
                    degraded,
                    expectedFormationEpoch: 1,
                    expectedLayout: PLANNED_LAYOUT
                }),
                read: criterionRead({ lifecycleState: 'connecting', formationEpoch: 1 }),
                facts: criterionFacts()
            });
            expect(computed.outcome).toBe('write');
            if (computed.outcome !== 'write') {
                continue;
            }
            const written = computed.guard.value as Group;
            expect(written.lifecycleState).toBe('active');
            expect(written.lastFormationOutcome).toMatchObject({ outcome, observedRate: 0.97 });
        }
    });

    it('leaves the recorded outcome untouched on manual activation', () => {
        const computed = computeGroupMutation({
            command: transitionCommand('activateGroup'),
            read: transitionRead({ lifecycleState: 'connecting', formationEpoch: 1 }),
            facts: transitionFacts()
        });
        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            return;
        }
        expect((computed.guard.value as Group).lastFormationOutcome).toBe(null);
    });

    it('treats an absent policy as the optimistic preset', () => {
        // optimistic is any-member initiated, so a plain member may command.
        const computed = computeGroupMutation({
            command: transitionCommand('startGroupEstablishment'),
            read: transitionRead({ lifecycleState: 'forming', formationEpoch: 0 }, { policyStatus: 'absent' }),
            facts: transitionFacts()
        });
        expect(computed.outcome).toBe('write');
    });
});

function transitionCommand(
    operation: 'startGroupEstablishment' | 'activateGroup' | 'reopenGroupEstablishment',
    actorPrincipalId = 'alice'
): GroupMutationCommand {
    return {
        operation,
        aggregateRef: groupRef('pure-room'),
        commandId: 'lifecycle-command',
        requestId: 'lifecycle-command',
        input: {
            actorPrincipalId,
            actorSessionId: `${actorPrincipalId}-session`,
            reason: null,
            traceId: null,
            ...(operation === 'activateGroup' ? { observedRate: null, degraded: null } : {})
        }
    } as GroupMutationCommand;
}

const PLANNED_LAYOUT = {
    groupRevision: 6,
    presenceRevision: 9,
    version: 2,
    state: 'active'
} as const;

function criterionRead(
    groupOverrides: Partial<Group>,
    plannedLayoutIdentity: GroupLayoutIdentity | null = PLANNED_LAYOUT
): GroupMutationRead {
    return {
        ...transitionRead(groupOverrides),
        actorMember: null,
        actorMemberEntry: null,
        plannedLayoutIdentity
    } as GroupMutationRead;
}

function criterionCommand(
    operation: 'activateGroup' | 'failGroupFormation',
    extras: Readonly<{
        observedRate: number;
        degraded?: boolean;
        expectedFormationEpoch?: number;
        expectedLayout?: GroupLayoutIdentity;
    }>
): GroupMutationCommand {
    return {
        operation,
        aggregateRef: groupRef('pure-room'),
        commandId: 'criterion-command',
        requestId: 'criterion-command',
        input: {
            actorPrincipalId: null,
            actorSessionId: null,
            reason: null,
            traceId: null,
            observedRate: extras.observedRate,
            expectedFormationEpoch: extras.expectedFormationEpoch ?? null,
            expectedLayout: extras.expectedLayout ?? null,
            ...(operation === 'activateGroup' ? { degraded: extras.degraded ?? false } : {})
        }
    } as GroupMutationCommand;
}

function criterionFacts(): GroupMutationFacts {
    return {
        ...transitionFacts(),
        internalAuthority: 'formation-criterion',
        authenticatedAuthority: null
    };
}

interface TransitionReadOptions {
    readonly policyStatus?: 'absent' | 'present' | 'managed' | 'corrupt';
    readonly actorPrincipalId?: string;
}

function transitionRead(groupOverrides: Partial<Group>, options: TransitionReadOptions = {}): GroupMutationRead {
    const actorPrincipalId = options.actorPrincipalId ?? 'alice';
    const audit = lifecycleAuditStamp(1_000, actorPrincipalId);
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
    const policyStatus = options.policyStatus ?? 'absent';
    const lifecyclePolicy = policyStatus === 'corrupt'
        ? { status: 'corrupt' as const, reason: 'stored policy is not an object' }
        : policyStatus === 'absent'
        ? { status: 'absent' as const }
        : {
            status: 'present' as const,
            policy: resolveGroupLifecyclePolicyPreset(policyStatus === 'managed' ? 'managed' : 'optimistic')
        };
    return {
        idempotency: null,
        group: storedEntry(groupStorageKey(), group),
        expiredGroupEntry: null,
        actorMember,
        targetMember: null,
        authorityMember: null,
        directorMember: null,
        actorMemberEntry: storedEntry(groupMemberStorageKey(actorPrincipalId), actorMember),
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
        activeMemberPrincipalIds: [actorPrincipalId],
        plannedLayoutIdentity: null
    } as GroupMutationRead;
}

function transitionFacts(principalId = 'alice'): GroupMutationFacts {
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

function lifecycleAuditStamp(atEpochMs: number, principalId: string): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId },
        reason: null,
        traceId: null,
        requestId: 'seed'
    };
}
