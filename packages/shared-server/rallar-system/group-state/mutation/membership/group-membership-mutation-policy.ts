import type { GroupEventType, GroupMember, GroupSnapshot } from '@shared/api/group-types.ts';
import {
  canActivateGroupMember,
  canJoinGroup,
  type GroupGovernanceAction,
  type GroupPolicyCapacityConfig,
} from '../../../group-policy.ts';

import type {
  GroupMutationCommand,
  GroupMutationFacts,
  GroupMutationRead,
} from '../group-mutation-contracts.ts';
import { GroupMutationRejectedError } from '../group-mutation-contracts.ts';
import {
  assertAllowed,
  assertGovernance,
  assertPrincipalAuthority,
} from '../aggregate/group-aggregate-mutation-policy.ts';

export function governanceActionFor(
  command: Extract<GroupMutationCommand, { targetPrincipalId: string }>,
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
  command: Extract<GroupMutationCommand, { targetPrincipalId: string }>,
  member: GroupMember,
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
  command: Extract<GroupMutationCommand, { targetPrincipalId: string }>,
  read: GroupMutationRead,
  member: GroupMember,
): GroupMember['role'] {
  const role = command.operation === 'setGroupMemberRole' ? command.input.role : member.role;
  if (command.operation === 'setGroupMemberRole' && role === 'owner') {
    throw new GroupMutationRejectedError(
      'Ownership can only change through transferGroupOwnership.',
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
  command: Extract<GroupMutationCommand, { targetPrincipalId: string }>,
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
  readonly command: Extract<GroupMutationCommand, { operation: 'upsertMember' }>;
  readonly read: GroupMutationRead;
  readonly facts: GroupMutationFacts;
  readonly isSelf: boolean;
}

export function assertUpsertAuthority({
  command,
  read,
  facts,
  isSelf,
}: AssertUpsertAuthorityInput): void {
  if (!isSelf) {
    assertGovernance({
      command,
      read,
      facts,
      action: command.input.status === 'banned' ? 'ban' : 'promote',
    });
    return;
  }
  assertPrincipalAuthority(command, command.targetPrincipalId);
  if (command.input.status !== 'active' && command.input.status !== 'left') {
    throw new GroupMutationRejectedError('Self upsert may only join or leave the group.');
  }
  if (command.input.role !== null && command.input.role !== (read.targetMember?.role ?? 'member')) {
    throw new GroupMutationRejectedError('Self upsert cannot change role.');
  }
}

export function assertUpsertRoleChange(
  command: Extract<GroupMutationCommand, { operation: 'upsertMember' }>,
  read: GroupMutationRead,
  isSelf: boolean,
): void {
  if (command.input.role === 'owner') {
    throw new GroupMutationRejectedError(
      'Ownership can only change through transferGroupOwnership.',
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
  readonly command: Extract<GroupMutationCommand, { operation: 'upsertMember' }>;
  readonly snapshot: GroupSnapshot;
  readonly nowEpochMs: number;
  readonly capacity: GroupPolicyCapacityConfig | undefined;
}

export function assertUpsertActivationAllowed({
  command,
  snapshot,
  nowEpochMs,
  capacity,
}: AssertUpsertActivationAllowedInput): void {
  if (command.input.status !== 'active') return;
  assertAllowed(
    command.input.actorPrincipalId === command.targetPrincipalId
      ? canJoinGroup({
          snapshot,
          actor: {
            principalId: command.input.actorPrincipalId ?? undefined,
            sessionId: command.input.actorSessionId ?? undefined,
          },
          nowEpochMs,
          capacity,
        })
      : canActivateGroupMember({
          snapshot,
          targetPrincipalId: command.targetPrincipalId,
          nowEpochMs,
          capacity,
        }),
  );
}
