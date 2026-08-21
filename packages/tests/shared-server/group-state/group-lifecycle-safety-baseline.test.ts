import { describe, expect, it } from 'vitest';

import { canConnectGroupPresenceSession, canGovernGroupMember, canJoinGroup } from '@shared-server/rallar-system/group-policy.ts';
import type {
    GroupMutationCommand,
    GroupMutationFacts,
    GroupMutationRead
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/services/group-state-mutations.ts';
import type { GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { AuditStamp, Group, GroupMember, GroupSnapshot } from '@shared/api/group-types.ts';
import { createTestGroup } from '../../create-test-group.ts';

import { groupMemberStorageKey, groupRef, groupStorageKey, storedEntry } from './mutation/group-mutation-test-runtime.ts';

const EVERY_LIFECYCLE_STATE: readonly GroupLifecycleState[] = ['forming', 'establishing', 'active', 'reconfiguring'];

/**
 * The safety-baseline invariant of the lifecycle plan: phases gate
 * establishment work, never the ability to be in the group. Every membership,
 * admission, and presence decision must hold in every lifecycle state,
 * including a group deliberately stuck in FORMING.
 */
describe('group lifecycle safety baseline', () => {
    it('admits joins in every lifecycle state', () => {
        for (const lifecycleState of EVERY_LIFECYCLE_STATE) {
            expect(
                canJoinGroup({
                    snapshot: snapshotIn(lifecycleState),
                    actor: { principalId: 'carol' }
                })
            ).toEqual({ allowed: true });
        }
    });

    it('admits presence sessions for active members in every lifecycle state', () => {
        for (const lifecycleState of EVERY_LIFECYCLE_STATE) {
            expect(
                canConnectGroupPresenceSession({
                    snapshot: snapshotIn(lifecycleState),
                    actor: { principalId: 'alice' },
                    sessionId: 'alice-session'
                })
            ).toEqual({ allowed: true });
        }
    });

    it('lets owners govern members in every lifecycle state', () => {
        for (const lifecycleState of EVERY_LIFECYCLE_STATE) {
            expect(
                canGovernGroupMember({
                    snapshot: snapshotIn(lifecycleState),
                    actor: { principalId: 'alice' },
                    targetPrincipalId: 'bob',
                    action: 'invite'
                })
            ).toEqual({ allowed: true });
        }
    });

    it('computes a join write on a group stuck in FORMING', () => {
        const computed = computeGroupMutation({
            command: joinCommand(),
            read: joinRead('forming'),
            facts: mutationFacts('carol')
        });
        expect(computed.outcome).toBe('write');
    });

    it('computes a presence connect write on a group stuck in FORMING', () => {
        const computed = computeGroupMutation({
            command: connectPresenceCommand(),
            read: memberRead('forming', 'alice'),
            facts: mutationFacts('alice')
        });
        expect(computed.outcome).toBe('write');
    });
});

function audit(principalId: string): AuditStamp {
    return {
        atEpochMs: 1_000,
        actor: { kind: 'principal', principalId },
        reason: null,
        traceId: null,
        requestId: 'seed'
    };
}

function member(principalId: string, role: GroupMember['role']): GroupMember {
    return {
        ...groupRef('pure-room'),
        principalId,
        role,
        status: 'active',
        joined: audit(principalId),
        updated: audit(principalId),
        left: null,
        removed: null,
        banned: null,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null
    };
}

function groupIn(lifecycleState: GroupLifecycleState): Group {
    return createTestGroup({
        ...groupRef('pure-room'),
        ownerPrincipalId: 'alice',
        lifecycleState,
        formationEpoch: lifecycleState === 'forming' ? 0 : 1,
        created: audit('alice'),
        updated: audit('alice')
    });
}

function snapshotIn(lifecycleState: GroupLifecycleState): GroupSnapshot {
    return {
        stateRevision: 1,
        causalRevision: { groupRevision: 1, presenceRevision: 0 },
        group: groupIn(lifecycleState),
        members: [member('alice', 'owner'), member('bob', 'member')],
        activeSessions: [],
        memberCount: 2,
        onlineMemberCount: 0
    };
}

function baseRead(lifecycleState: GroupLifecycleState): GroupMutationRead {
    const actorMember = member('alice', 'owner');
    return {
        idempotency: null,
        group: storedEntry(groupStorageKey(), groupIn(lifecycleState)),
        expiredGroupEntry: null,
        actorMember,
        targetMember: null,
        authorityMember: null,
        directorMember: null,
        actorMemberEntry: storedEntry(groupMemberStorageKey('alice'), actorMember),
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
        lifecyclePolicy: null,
        activeMemberPrincipalIds: null
    } as GroupMutationRead;
}

function joinRead(lifecycleState: GroupLifecycleState): GroupMutationRead {
    // Joining consults the admission policy, so its read carries one; absent is
    // the open admission this baseline asserts survives a group stuck in FORMING.
    return {
        ...baseRead(lifecycleState),
        actorMember: null,
        actorMemberEntry: null,
        lifecyclePolicy: { status: 'absent' }
    } as GroupMutationRead;
}

function memberRead(lifecycleState: GroupLifecycleState, principalId: string): GroupMutationRead {
    const stored = baseRead(lifecycleState);
    return {
        ...stored,
        targetMember: stored.actorMember,
        targetMemberEntry: stored.actorMemberEntry
    } as GroupMutationRead;
}

function joinCommand(): GroupMutationCommand {
    return {
        operation: 'joinGroup',
        aggregateRef: groupRef('pure-room'),
        commandId: 'safety-join',
        requestId: 'safety-join',
        targetPrincipalId: 'carol',
        input: {
            inviteToken: null,
            joinCode: null,
            actorPrincipalId: 'carol',
            actorSessionId: 'carol-session',
            reason: null,
            traceId: null
        }
    } as GroupMutationCommand;
}

function connectPresenceCommand(): GroupMutationCommand {
    return {
        operation: 'connectPresence',
        aggregateRef: groupRef('pure-room'),
        commandId: 'safety-connect',
        requestId: 'safety-connect',
        sessionId: 'alice-session',
        input: {
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            reason: null,
            traceId: null,
            principalId: 'alice',
            generationId: 'generation-1',
            connectedAtEpochMs: 2_000,
            lastHeartbeatAtEpochMs: 2_000,
            expiresAtEpochMs: 62_000
        }
    } as GroupMutationCommand;
}

function mutationFacts(principalId: string): GroupMutationFacts {
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
        formationDamping: 'legacy',
        authenticatedAuthority: {
            principalId,
            sessionId: `${principalId}-session`
        }
    };
}
