import type { Group, GroupEventType, GroupMember, GroupSnapshot } from '@shared/api/group-types.ts';

import type { GroupStateValidationIssue } from '../../group-state-validation-issues.ts';
import type { GroupGovernanceAction } from '../../policy/group-governance-policy.ts';
import {
    canActivateGroupMember,
    canChangeOwnGroupMembership,
    canJoinGroup,
    type GroupPolicyCapacityConfig
} from '../../policy/group-membership-admission-policy.ts';
import { GroupPolicyDeniedError } from '../../policy/group-policy-result.ts';
import { readJoinCode } from '../aggregate/compute-group-aggregate-mutation.ts';
import {
    canGovernGroupMutation,
    toPolicySnapshot,
    validatePrincipalAuthority
} from '../aggregate/group-aggregate-mutation-policy.ts';
import {
    GroupMutationRejectedError,
    type GroupMutationCommand,
    type GroupMutationFacts,
    type GroupMutationRead
} from '../group-mutation-contracts.ts';
import { validateRequiredGroup } from '../group-mutation-result.ts';

interface GroupMemberUpsertAuthorityInput {
    readonly command: Extract<GroupMutationCommand, { operation: 'upsertMember'; }>;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly isSelf: boolean;
}

interface GroupMemberActivationInput {
    readonly command: Extract<GroupMutationCommand, { operation: 'upsertMember'; }>;
    readonly snapshot: GroupSnapshot;
    readonly nowEpochMs: number;
    readonly capacity: GroupPolicyCapacityConfig | undefined;
}

interface GroupRemainingOwnerInput {
    readonly group: Group;
    readonly existing: GroupMember | undefined;
    readonly nextStatus: GroupMember['status'];
    readonly nextRole: GroupMember['role'];
}

export function validateGroupMembershipMutationPolicy(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): readonly GroupStateValidationIssue[] {
    if (read.idempotency !== null || read.group === null) {
        return [];
    }
    switch (command.operation) {
        case 'createGroupInvite':
            return validateGroupInvite(command, read, facts);
        case 'revokeGroupInvite':
            return validateMembershipGovernance({ command, read, facts, action: 'remove' });
        case 'removeGroupMember':
        case 'banGroupMember':
        case 'unbanGroupMember':
        case 'setGroupMemberRole':
            return validateGovernedGroupMember(command, read, facts);
        case 'transferGroupOwnership':
            return validateGroupOwnershipTransfer(command, read, facts);
        case 'upsertMember':
            return validateGroupMemberUpsert(command, read, facts);
        case 'joinGroup':
        case 'acceptGroupInvite':
            return validateGroupJoin(command, read, facts);
        default:
            return [];
    }
}

function validateGroupMemberUpsert(
    command: Extract<GroupMutationCommand, { operation: 'upsertMember'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): readonly GroupStateValidationIssue[] {
    if (read.group === null) {
        return validateRequiredGroup(read, command.aggregateRef);
    }
    const isSelf = command.input.actorPrincipalId === command.targetPrincipalId;
    return [
        ...validateUpsertAuthority({ command, read, facts, isSelf }),
        ...validateMembershipRoleChange(command.input.role, read, isSelf),
        ...validateUpsertActivationAllowed({
            command,
            snapshot: toPolicySnapshot(read, command.aggregateRef, facts.nowEpochMs),
            nowEpochMs: facts.nowEpochMs,
            capacity: facts.capacity
        }),
        ...validateRemainingGroupOwner({
            group: read.group.value,
            existing: read.targetMember ?? undefined,
            nextStatus: command.input.status,
            nextRole: command.input.role ?? read.targetMember?.role ?? 'member'
        })
    ];
}

export function validateGroupJoin(
    command: Extract<GroupMutationCommand, { operation: 'joinGroup' | 'acceptGroupInvite'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): readonly GroupStateValidationIssue[] {
    const issues = [...validatePrincipalAuthority(command, command.targetPrincipalId)];
    if (read.group === null) {
        return [...issues, ...validateRequiredGroup(read, command.aggregateRef)];
    }
    const metadata = readJoinCode(read.group.value.metadata);
    const decision = canJoinGroup({
        snapshot: toPolicySnapshot(read, command.aggregateRef, facts.nowEpochMs),
        actor: {
            principalId: command.input.actorPrincipalId ?? undefined,
            sessionId: command.input.actorSessionId ?? undefined
        },
        nowEpochMs: facts.nowEpochMs,
        capacity: facts.capacity,
        inviteToken: command.input.inviteToken ?? undefined,
        joinCode: command.input.joinCode ?? undefined,
        joinCodeVerifier: facts.joinCodeVerifier ?? undefined,
        expectedJoinCodeVerifier: read.group.value.joinMode === 'code' ? (metadata?.verifier ?? '') : undefined,
        joinCodeExpiresAtEpochMs: metadata?.expiresAtEpochMs
    });
    if (!decision.allowed) {
        issues.push({ path: 'read', cause: new GroupPolicyDeniedError(decision) });
    }
    return issues;
}

export function validateGroupInvite(
    command: Extract<GroupMutationCommand, { operation: 'createGroupInvite'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): readonly GroupStateValidationIssue[] {
    const issues = [...validateMembershipGovernance({ command, read, facts, action: 'invite' })];
    if (read.targetMember?.status === 'banned') {
        issues.push({
            path: 'read.targetMember.status',
            cause: new GroupMutationRejectedError('Cannot invite a banned group member.')
        });
    }
    return issues;
}

export function validateGovernedGroupMember(
    command: Extract<GroupMutationCommand, { targetPrincipalId: string; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): readonly GroupStateValidationIssue[] {
    const issues = [
        ...validateMembershipGovernance({ command, read, facts, action: computeGovernanceAction(command) })
    ];
    const member = read.targetMember;
    if (member === null) {
        if (command.operation === 'setGroupMemberRole') {
            issues.push({
                path: 'read.targetMember',
                cause: new GroupMutationRejectedError(`Group member not found: ${command.targetPrincipalId}`)
            });
        }
        return issues;
    }
    if (command.operation === 'setGroupMemberRole') {
        issues.push(...validateMembershipRoleChange(command.input.role, read, false));
    }
    if (read.group !== null) {
        issues.push(...validateRemainingGroupOwner({
            group: read.group.value,
            existing: member,
            nextStatus: computeGovernedMemberStatus(command, member),
            nextRole: computeGovernedMemberRole(command, member)
        }));
    }
    return issues;
}

export function validateGroupOwnershipTransfer(
    command: Extract<GroupMutationCommand, { operation: 'transferGroupOwnership'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): readonly GroupStateValidationIssue[] {
    const issues = [...validateMembershipGovernance({ command, read, facts, action: 'transfer-ownership' })];
    if (read.actorMember?.status !== 'active' || read.actorMember.role !== 'owner') {
        issues.push({
            path: 'read.actorMember',
            cause: new GroupMutationRejectedError('Only an active owner can transfer ownership.')
        });
    }
    if (read.targetMember?.status !== 'active') {
        issues.push({
            path: 'read.targetMember',
            cause: new GroupMutationRejectedError('Ownership target must be active.')
        });
    }
    return issues;
}

export function validateUpsertAuthority(input: GroupMemberUpsertAuthorityInput): readonly GroupStateValidationIssue[] {
    const { command, read, facts, isSelf } = input;
    if (!isSelf) {
        return validateMembershipGovernance({
            command,
            read,
            facts,
            action: command.input.status === 'banned' ? 'ban' : 'promote'
        });
    }
    const issues = [...validatePrincipalAuthority(command, command.targetPrincipalId)];
    const decision = canChangeOwnGroupMembership(read.targetMember ?? undefined);
    if (!decision.allowed) {
        issues.push({ path: 'read.targetMember', cause: new GroupPolicyDeniedError(decision) });
    }
    if (command.input.status !== 'active' && command.input.status !== 'left') {
        issues.push({
            path: 'command.input.status',
            cause: new GroupMutationRejectedError('Self upsert may only join or leave the group.')
        });
    }
    if (command.input.role !== null && command.input.role !== (read.targetMember?.role ?? 'member')) {
        issues.push({
            path: 'command.input.role',
            cause: new GroupMutationRejectedError('Self upsert cannot change role.')
        });
    }
    return issues;
}

export function validateUpsertActivationAllowed(
    input: GroupMemberActivationInput
): readonly GroupStateValidationIssue[] {
    const { command, snapshot, nowEpochMs, capacity } = input;
    if (command.input.status !== 'active') {
        return [];
    }
    const decision = command.input.actorPrincipalId === command.targetPrincipalId
        ? canJoinGroup({
            snapshot,
            actor: {
                principalId: command.input.actorPrincipalId ?? undefined,
                sessionId: command.input.actorSessionId ?? undefined
            },
            nowEpochMs,
            capacity
        })
        : canActivateGroupMember({ snapshot, targetPrincipalId: command.targetPrincipalId, nowEpochMs, capacity });
    return decision.allowed ? [] : [{ path: 'read', cause: new GroupPolicyDeniedError(decision) }];
}

export function validateRemainingGroupOwner(input: GroupRemainingOwnerInput): readonly GroupStateValidationIssue[] {
    const { existing, group, nextRole, nextStatus } = input;
    if (!existing || existing.role !== 'owner' || existing.status !== 'active') {
        return [];
    }
    if (nextStatus === 'active' && nextRole === 'owner') {
        return [];
    }
    return group.ownerPrincipalId === existing.principalId
        ? [{
            path: 'read.targetMember',
            cause: new GroupPolicyDeniedError({
                allowed: false,
                code: 'last-owner',
                message: 'Cannot remove or demote the last active owner.'
            })
        }]
        : [];
}

export function computeGovernedMemberStatus(
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

export function computeGovernedMemberRole(
    command: Extract<GroupMutationCommand, { targetPrincipalId: string; }>,
    member: GroupMember
): GroupMember['role'] {
    return command.operation === 'setGroupMemberRole' ? command.input.role : member.role;
}

export function computeGovernedMemberEventType(
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

function computeGovernanceAction(
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

interface GroupMembershipGovernanceInput {
    readonly command: Extract<GroupMutationCommand, { targetPrincipalId: string; }>;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly action: GroupGovernanceAction;
}

function validateMembershipGovernance(
    { command, read, facts, action }: GroupMembershipGovernanceInput
): readonly GroupStateValidationIssue[] {
    if (read.group === null) {
        return validateRequiredGroup(read, command.aggregateRef);
    }
    const decision = canGovernGroupMutation({ command, read, facts, action });
    return decision.allowed ? [] : [{ path: 'read', cause: new GroupPolicyDeniedError(decision) }];
}

export function validateMembershipRoleChange(
    role: GroupMember['role'] | null,
    read: GroupMutationRead,
    isSelf: boolean
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (role === 'owner') {
        issues.push({
            path: 'command.input.role',
            cause: new GroupMutationRejectedError('Ownership can only change through transferGroupOwnership.')
        });
    }
    if (!isSelf && role === 'admin' && read.actorMember?.role === 'admin' && read.targetMember?.role !== 'admin') {
        issues.push({
            path: 'command.input.role',
            cause: new GroupMutationRejectedError('Group admins cannot grant the admin role.')
        });
    }
    return issues;
}
