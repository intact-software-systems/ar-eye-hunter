import type { GroupPolicyResult } from '@shared/api/group-policy-types.ts';
import type { GroupMember, GroupSnapshot } from '@shared/api/group-types.ts';
import { denyForBlockedGroupMember, findGroupMember } from './group-policy-primitives.ts';
import { denyGroupPolicy, GROUP_POLICY_ALLOWED, type GroupPolicyActor } from './group-policy-result.ts';

export interface CanReadGroupSnapshotInput {
    readonly snapshot: GroupSnapshot;
    readonly actor: GroupPolicyActor;
    readonly nowEpochMs?: number;
}

export type GroupReadVisibility = 'full' | 'invite' | 'directory' | 'none';

export function canReadGroupSnapshot(
    input: CanReadGroupSnapshotInput
): GroupPolicyResult {
    if (input.snapshot.group.status === 'deleted') {
        return denyGroupPolicy('group-deleted', 'Deleted groups are not readable.');
    }
    const principalId = input.actor.principalId;
    if (!principalId) {
        return denyGroupPolicy(
            'group-policy-denied',
            'A principal is required to read group state.'
        );
    }
    const blockedDenial = denyForBlockedGroupMember(
        findGroupMember(input.snapshot, principalId)
    );
    if (blockedDenial) {
        return blockedDenial;
    }
    const visibility = readGroupVisibility(input);
    return visibility === 'full'
        ? GROUP_POLICY_ALLOWED
        : denyGroupPolicy(
            'group-policy-denied',
            'Only active group members can read full group state.',
            { visibility }
        );
}

export function readGroupVisibility(
    input: CanReadGroupSnapshotInput
): GroupReadVisibility {
    if (input.snapshot.group.status === 'deleted') {
        return 'none';
    }
    const principalId = input.actor.principalId;
    if (!principalId) {
        return readDirectoryVisibility(input.snapshot);
    }
    const member = findGroupMember(input.snapshot, principalId);
    switch (member?.status) {
        case 'active':
            return 'full';
        case 'invited':
            return isInviteExpired(member, input.nowEpochMs)
                ? readDirectoryVisibility(input.snapshot)
                : 'invite';
        case 'pending':
            return 'invite';
        case 'left':
        case undefined:
            return readDirectoryVisibility(input.snapshot);
        case 'removed':
        case 'banned':
            return 'none';
    }
}

function readDirectoryVisibility(snapshot: GroupSnapshot): GroupReadVisibility {
    return snapshot.group.status === 'active' && snapshot.group.joinMode === 'open'
        ? 'directory'
        : 'none';
}

function isInviteExpired(member: GroupMember, nowEpochMs: number | undefined): boolean {
    return member.invitationExpiresAtEpochMs !== null &&
        nowEpochMs !== undefined &&
        member.invitationExpiresAtEpochMs <= nowEpochMs;
}
