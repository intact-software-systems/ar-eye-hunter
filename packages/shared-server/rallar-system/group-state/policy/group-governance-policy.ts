import type { GroupPolicyResult } from '@shared/api/group-policy-types.ts';
import type { GroupMember, GroupSnapshot } from '@shared/api/group-types.ts';
import {
    denyUnlessActiveGroupMember,
    findActorGroupMember,
    findGroupMember,
    isActiveGroupOwnerOrAdmin,
    requireActiveGroup
} from './group-policy-primitives.ts';
import { denyGroupPolicy, GROUP_POLICY_ALLOWED, type GroupPolicyActor } from './group-policy-result.ts';

export interface CanUpdateGroupSnapshotInput {
    readonly snapshot: GroupSnapshot;
    readonly actor: GroupPolicyActor;
    readonly nowEpochMs?: number;
}

export type GroupGovernanceAction =
    | 'invite'
    | 'remove'
    | 'ban'
    | 'unban'
    | 'promote'
    | 'demote'
    | 'transfer-ownership';

export interface CanGovernGroupMemberInput {
    readonly snapshot: GroupSnapshot;
    readonly actor: GroupPolicyActor;
    readonly targetPrincipalId: string;
    readonly action: GroupGovernanceAction;
}

export function canUpdateGroupSnapshot(
    input: CanUpdateGroupSnapshotInput
): GroupPolicyResult {
    const lifecycleDenial = requireActiveGroup(input.snapshot.group, input.nowEpochMs);
    if (lifecycleDenial) {
        return lifecycleDenial;
    }
    const actorMember = findActorGroupMember(input.snapshot, input.actor);
    const memberDenial = denyUnlessActiveGroupMember(actorMember);
    if (memberDenial) {
        return memberDenial;
    }
    return actorMember?.role === 'owner' || actorMember?.role === 'admin'
        ? GROUP_POLICY_ALLOWED
        : denyGroupPolicy(
            'forbidden-role',
            'Only active group owners/admins can update groups.'
        );
}

export function canGovernGroupMember(
    input: CanGovernGroupMemberInput
): GroupPolicyResult {
    const actorMember = findActorGroupMember(input.snapshot, input.actor);
    if (!isActiveGroupOwnerOrAdmin(actorMember)) {
        return denyGroupPolicy(
            'forbidden-role',
            'Only active group owners/admins can govern group members.'
        );
    }
    if (input.action === 'transfer-ownership' && actorMember.role !== 'owner') {
        return denyGroupPolicy(
            'forbidden-role',
            'Only active group owners can transfer group ownership.'
        );
    }
    const targetMember = findGroupMember(input.snapshot, input.targetPrincipalId);
    if (
        actorMember.role === 'admin' &&
        targetMember &&
        (targetMember.role === 'owner' || targetMember.role === 'admin')
    ) {
        return denyGroupPolicy(
            'forbidden-role',
            'Group admins can only govern regular members.'
        );
    }
    if (
        targetMember &&
        isLastActiveOwner(input.snapshot, targetMember) &&
        removesOwner(input.action)
    ) {
        return denyGroupPolicy('last-owner', 'Cannot leave an active group without an owner.');
    }
    return GROUP_POLICY_ALLOWED;
}

function isLastActiveOwner(snapshot: GroupSnapshot, member: GroupMember): boolean {
    return member.role === 'owner' &&
        member.status === 'active' &&
        snapshot.group.ownerPrincipalId === member.principalId;
}

function removesOwner(action: GroupGovernanceAction): boolean {
    return action === 'remove' ||
        action === 'ban' ||
        action === 'demote' ||
        action === 'transfer-ownership';
}
