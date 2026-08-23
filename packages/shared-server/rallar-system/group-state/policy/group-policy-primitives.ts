import type { GroupPolicyDenied } from '@shared/api/group-policy-types.ts';
import type { Group, GroupMember, GroupPresenceSession, GroupSnapshot } from '@shared/api/group-types.ts';
import { denyGroupPolicy, type GroupPolicyActor } from './group-policy-result.ts';

export function requireActiveGroup(
    group: Group,
    nowEpochMs: number | undefined
): GroupPolicyDenied | undefined {
    if (group.status === 'archived') {
        return denyGroupPolicy('group-archived', 'Group is archived.');
    }
    if (group.status === 'deleted') {
        return denyGroupPolicy('group-deleted', 'Group is deleted.');
    }
    if (group.status !== 'active') {
        return denyGroupPolicy('group-not-active', 'Group is not active.');
    }
    if (
        group.expiresAtEpochMs !== null &&
        nowEpochMs !== undefined &&
        group.expiresAtEpochMs <= nowEpochMs
    ) {
        return denyGroupPolicy('group-not-active', 'Group has expired.');
    }
    return undefined;
}

export function findGroupMember(
    snapshot: GroupSnapshot,
    principalId: string
): GroupMember | undefined {
    return snapshot.members.find((member) => member.principalId === principalId);
}

export function findActorGroupMember(
    snapshot: GroupSnapshot,
    actor: GroupPolicyActor
): GroupMember | undefined {
    return actor.principalId ? findGroupMember(snapshot, actor.principalId) : undefined;
}

export function denyForBlockedGroupMember(
    member: GroupMember | undefined
): GroupPolicyDenied | undefined {
    if (member?.status === 'removed') {
        return denyGroupPolicy('member-removed', 'Group member has been removed.');
    }
    if (member?.status === 'banned') {
        return denyGroupPolicy('member-banned', 'Group member has been banned.');
    }
    return undefined;
}

export function denyUnlessActiveGroupMember(
    member: GroupMember | undefined
): GroupPolicyDenied | undefined {
    const blocked = denyForBlockedGroupMember(member);
    if (blocked) {
        return blocked;
    }
    return !member || member.status !== 'active'
        ? denyGroupPolicy(
            'member-not-active',
            'An active group member is required for this operation.'
        )
        : undefined;
}

export function isActiveGroupOwnerOrAdmin(
    member: GroupMember | undefined
): member is GroupMember {
    return member?.status === 'active' &&
        (member.role === 'owner' || member.role === 'admin');
}

export function isLiveGroupPresenceSession(
    session: GroupPresenceSession,
    nowEpochMs: number | undefined
): boolean {
    return session.disconnectedAtEpochMs === null &&
        (nowEpochMs === undefined || session.expiresAtEpochMs > nowEpochMs);
}
