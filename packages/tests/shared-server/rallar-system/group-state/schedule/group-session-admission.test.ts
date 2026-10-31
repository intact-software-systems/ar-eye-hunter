import { describe, expect, it } from 'vitest';

import {
    canActivateGroupMember,
    canConnectGroupPresenceSession,
    canJoinGroup
} from '@shared-server/rallar-system/group-state/policy/group-membership-admission-policy.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { createTestGroup } from '../../../../create-test-group.ts';

const group = createTestGroup({
    maxMembers: 2,
    metadata: {
        rallarSessionSchedule: { revision: 1, startsAtEpochMs: 3_600_000, cancelledAtEpochMs: null },
        rallarSpectatorCapacity: 2
    }
});
const snapshot: GroupSnapshot = {
    group,
    causalRevision: { groupRevision: 1, presenceRevision: 0 },
    members: [{
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        groupId: group.groupId,
        principalId: 'owner',
        role: 'owner',
        status: 'active',
        joined: group.created,
        updated: group.updated,
        left: null,
        removed: null,
        banned: null,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null
    }],
    activeSessions: [],
    memberCount: 1,
    onlineMemberCount: 0,
    publicationGrants: []
};
const sessionReservations = { scheduleRevision: 1, principalIds: ['alice'] };

const admission = { snapshot, sessionReservations, nowEpochMs: 3_000_000 };

describe('scheduled room admission policy', () => {
    it('holds reserved seats across joins and governance admission until the exact deadline', () => {
        expect(canJoinGroup({ ...admission, actor: { principalId: 'alice' } })).toEqual({ allowed: true });
        expect(canJoinGroup({ ...admission, actor: { principalId: 'bob' } }))
            .toMatchObject({ allowed: false, code: 'group-full' });
        expect(canActivateGroupMember({ ...admission, targetPrincipalId: 'alice' })).toEqual({ allowed: true });
        expect(canActivateGroupMember({ ...admission, targetPrincipalId: 'bob' }))
            .toMatchObject({ allowed: false, code: 'group-full' });
        expect(canJoinGroup({ ...admission, nowEpochMs: 4_200_000, actor: { principalId: 'bob' } }))
            .toEqual({ allowed: true });
    });

    it('refuses every admission path before opening, including the existing owner and presence', () => {
        const early = { ...admission, nowEpochMs: 2_999_999 };
        expect(canJoinGroup({ ...early, actor: { principalId: 'alice' } }))
            .toMatchObject({ allowed: false, code: 'group-admission-closed' });
        expect(canJoinGroup({ ...early, actor: { principalId: 'owner' } }))
            .toMatchObject({ allowed: false, code: 'group-admission-closed' });
        expect(canActivateGroupMember({ ...early, targetPrincipalId: 'alice' }))
            .toMatchObject({ allowed: false, code: 'group-admission-closed' });
        expect(canConnectGroupPresenceSession({ ...early, actor: { principalId: 'owner' }, sessionId: 'owner-tab' }))
            .toMatchObject({ allowed: false, code: 'group-admission-closed' });
        expect(canConnectGroupPresenceSession({ ...admission, actor: { principalId: 'owner' }, sessionId: 'owner-tab' }))
            .toEqual({ allowed: true });
    });

    it('keeps spectator capacity separate and does not let a reservation replace an admission credential', () => {
        expect(canJoinGroup({ ...admission, actor: { principalId: 'bob' }, participation: 'spectator' }))
            .toEqual({ allowed: true });
        expect(canJoinGroup({
            ...admission,
            snapshot: { ...snapshot, group: { ...group, joinMode: 'code' } },
            actor: { principalId: 'alice' }
        })).toMatchObject({ allowed: false, code: 'group-code-required' });
    });

    it('fails closed when a scheduled player admission omits its private reservation read', () => {
        expect(() => canJoinGroup({ snapshot, actor: { principalId: 'bob' }, nowEpochMs: 3_000_000 }))
            .toThrow(TypeError);
    });

    it('keeps a cancelled session closed even to its owner after the original start', () => {
        expect(canJoinGroup({
            ...admission,
            snapshot: {
                ...snapshot,
                group: {
                    ...group,
                    metadata: {
                        rallarSessionSchedule: { revision: 1, startsAtEpochMs: 3_600_000, cancelledAtEpochMs: 2_000_000 }
                    }
                }
            },
            actor: { principalId: 'owner' },
            nowEpochMs: 5_000_000
        })).toMatchObject({ allowed: false, code: 'group-admission-closed' });
    });
});
