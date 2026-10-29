import type { GroupEventType, GroupMember, GroupSnapshot } from '@shared/api/group-types.ts';
import type { GroupGovernanceAction } from '../../policy/group-governance-policy.ts';
import {
    canActivateGroupMember,
    canChangeOwnGroupMembership,
    canJoinGroup,
    type GroupPolicyCapacityConfig
} from '../../policy/group-membership-admission-policy.ts';

import {
    assertAllowed,
    assertGovernance,
    assertPrincipalAuthority,
    toPolicySnapshot
} from '../aggregate/group-aggregate-mutation-policy.ts';
import type { GroupMutationCommand, GroupMutationFacts, GroupMutationRead } from '../group-mutation-contracts.ts';
import { GroupMutationRejectedError } from '../group-mutation-contracts.ts';
import { assertGroupAdmissionWindowsOpen, resolveAdmittedMemberStatus } from './compute-group-admission-mutation.ts';

interface ResolveUpsertMemberStatusInput {
    readonly command: Extract<GroupMutationCommand, { operation: 'upsertMember'; }>;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly role: GroupMember['role'];
}

export function resolveUpsertMemberStatus(
    { command, read, facts, role }: ResolveUpsertMemberStatusInput
): GroupMember['status'] {
    const existing = read.targetMember ?? undefined;
    if (
        command.input.status !== 'active' ||
        (existing?.status === 'active' &&
            !(existing.role === 'spectator' && command.input.role !== null && command.input.role !== 'spectator')) ||
        role === 'spectator'
    ) {
        return command.input.status;
    }
    // Self-activation requests admission; a manager grants it within the same admission windows.
    if (command.input.actorPrincipalId === command.targetPrincipalId) {
        return resolveAdmittedMemberStatus({ read, facts, existing });
    }
    assertGroupAdmissionWindowsOpen(read, facts);
    return command.input.status;
}

export function governanceActionFor(
    command: Extract<GroupMutationCommand, { targetPrincipalId: string; }>
): GroupGovernanceAction {
    return command.operation === 'banGroupMember'
        ? 'ban'
        : command.operation === 'unbanGroupMember'
        ? 'unban'
        : command.operation === 'setGroupMemberRole'
        ? 'promote'
        : 'remove';
}

export function governedMemberStatus(
    command: Extract<GroupMutationCommand, { targetPrincipalId: string; }>,
    member: GroupMember
): GroupMember['status'] {
    return command.operation === 'banGroupMember'
        ? 'banned'
        : command.operation === 'unbanGroupMember'
        ? 'left'
        : command.operation === 'removeGroupMember'
        ? 'removed'
        : member.status;
}

export function governedMemberRole(
    command: Extract<GroupMutationCommand, { targetPrincipalId: string; }>,
    read: GroupMutationRead,
    member: GroupMember
): GroupMember['role'] {
    const role = command.operation === 'setGroupMemberRole' ? command.input.role : member.role;
    if (command.operation === 'setGroupMemberRole' && role === 'owner') {
        throw new GroupMutationRejectedError(
            'Ownership can only change through transferGroupOwnership.'
        );
    }
    if (
        command.operation === 'setGroupMemberRole' &&
        role === 'admin' &&
        read.actorMember?.role === 'admin' &&
        member.role !== 'admin'
    ) {
        throw new GroupMutationRejectedError('Group admins cannot grant the admin role.');
    }
    return role;
}

export function governedMemberEventType(
    command: Extract<GroupMutationCommand, { targetPrincipalId: string; }>
): GroupEventType {
    return command.operation === 'banGroupMember'
        ? 'member-banned'
        : command.operation === 'unbanGroupMember'
        ? 'member-unbanned'
        : command.operation === 'setGroupMemberRole'
        ? 'member-role-changed'
        : 'member-removed';
}

interface AssertUpsertAuthorityInput {
    readonly command: Extract<GroupMutationCommand, { operation: 'upsertMember'; }>;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly isSelf: boolean;
}

export function assertUpsertAuthority({
    command,
    read,
    facts,
    isSelf
}: AssertUpsertAuthorityInput): void {
    if (!isSelf) {
        assertGovernance({
            command,
            read,
            facts,
            action: command.input.status === 'banned' ? 'ban' : 'promote'
        });
        return;
    }
    assertPrincipalAuthority(command, command.targetPrincipalId);
    assertAllowed(canChangeOwnGroupMembership(read.targetMember ?? undefined));
    if (command.input.status !== 'active' && command.input.status !== 'left') {
        throw new GroupMutationRejectedError('Self upsert may only join or leave the group.');
    }
    if (command.input.role !== null && command.input.role !== (read.targetMember?.role ?? 'member')) {
        throw new GroupMutationRejectedError('Self upsert cannot change role.');
    }
}

export function assertUpsertRoleChange(
    command: Extract<GroupMutationCommand, { operation: 'upsertMember'; }>,
    read: GroupMutationRead,
    isSelf: boolean
): void {
    if (command.input.role === 'owner') {
        throw new GroupMutationRejectedError(
            'Ownership can only change through transferGroupOwnership.'
        );
    }
    if (
        !isSelf &&
        command.input.role === 'admin' &&
        read.actorMember?.role === 'admin' &&
        read.targetMember?.role !== 'admin'
    ) {
        throw new GroupMutationRejectedError('Group admins cannot grant the admin role.');
    }
}

interface AssertUpsertActivationAllowedInput {
    readonly command: Extract<GroupMutationCommand, { operation: 'upsertMember'; }>;
    readonly snapshot: GroupSnapshot;
    readonly role: GroupMember['role'];
    readonly nowEpochMs: number;
    readonly capacity: GroupPolicyCapacityConfig | undefined;
}

export function assertUpsertActivationAllowed({
    command,
    snapshot,
    role,
    nowEpochMs,
    capacity
}: AssertUpsertActivationAllowedInput): void {
    if (command.input.status !== 'active') {
        return;
    }
    assertAllowed(
        command.input.actorPrincipalId === command.targetPrincipalId
            ? canJoinGroup({
                snapshot,
                actor: {
                    principalId: command.input.actorPrincipalId ?? undefined,
                    sessionId: command.input.actorSessionId ?? undefined
                },
                nowEpochMs,
                capacity,
                participation: role === 'spectator' ? 'spectator' : 'player'
            })
            : canActivateGroupMember({
                snapshot,
                targetPrincipalId: command.targetPrincipalId,
                role,
                nowEpochMs,
                capacity
            })
    );
}

interface AssertGovernedParticipationChangeInput {
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly role: GroupMember['role'];
}

export function assertGovernedParticipationChange(
    { command, read, facts, role }: AssertGovernedParticipationChangeInput
): void {
    const member = read.targetMember;
    if (member?.status !== 'active' || (member.role === 'spectator') === (role === 'spectator')) {
        return;
    }
    assertAllowed(canActivateGroupMember({
        snapshot: toPolicySnapshot(read, command.aggregateRef, facts.attemptAtEpochMs),
        targetPrincipalId: member.principalId,
        role,
        nowEpochMs: facts.attemptAtEpochMs,
        capacity: facts.capacity
    }));
    if (member.role === 'spectator' && role !== 'spectator') {
        assertGroupAdmissionWindowsOpen(read, facts);
    }
}
