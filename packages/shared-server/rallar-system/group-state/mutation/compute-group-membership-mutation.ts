import type { AuditStamp, Group, GroupEventType, GroupMember, GroupMemberStatus } from '@shared/api/group-types.ts';
import { canActivateGroupMember, canJoinGroup, type GroupGovernanceAction } from '../../group-policy.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

import type { GroupMutationCommand, GroupMutationComputed, GroupMutationFacts, GroupMutationRead } from './group-mutation-contracts.ts';
import { GroupMutationRejectedError } from './group-mutation-contracts.ts';
import { assertAllowed, assertGovernance, assertNotLastOwner, readJoinCode, toPolicySnapshot } from './compute-group-aggregate-mutation.ts';
import { auditStamp, noOp, requireGroup, writeResult } from './group-mutation-result.ts';
import { admissionForMemberWrite, assertPrincipalAuthority } from './compute-group-presence-mutation.ts';

const DEFAULT_GROUP_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export function computeJoin(
  command: Extract<GroupMutationCommand, { operation: 'joinGroup' | 'acceptGroupInvite' }>,
  read: GroupMutationRead,
  facts: GroupMutationFacts,
): GroupMutationComputed {
  assertPrincipalAuthority(command, command.targetPrincipalId);
  const stored = requireGroup(read, command.aggregateRef);
  const snapshot = toPolicySnapshot(read, facts.nowEpochMs);
  const joinCodeMetadata = readJoinCode(stored.value.metadata);
  assertAllowed(
    canJoinGroup({
      snapshot,
      actor: {
        principalId: command.input.actorPrincipalId ?? undefined,
        sessionId: command.input.actorSessionId ?? undefined,
      },
      nowEpochMs: facts.nowEpochMs,
      inviteToken: command.input.inviteToken ?? undefined,
      joinCode: command.input.joinCode ?? undefined,
      joinCodeVerifier: facts.joinCodeVerifier ?? undefined,
      expectedJoinCodeVerifier: stored.value.joinMode === 'code' ? (joinCodeMetadata?.verifier ?? '') : undefined,
      joinCodeExpiresAtEpochMs: joinCodeMetadata?.expiresAtEpochMs,
    }),
  );
  const existing = read.targetMember ?? undefined;
  if (existing?.status === 'active') return noOp(command, read, facts);
  const audit = auditStamp(command, facts, command.targetPrincipalId);
  const member: GroupMember = {
    ...command.aggregateRef,
    principalId: command.targetPrincipalId,
    role: existing?.role ?? 'member',
    status: 'active',
    joined: existing?.joined ?? audit,
    updated: audit,
    left: null,
    removed: null,
    banned: null,
    invitedByPrincipalId: existing?.invitedByPrincipalId ?? null,
    invitationExpiresAtEpochMs: existing?.invitationExpiresAtEpochMs ?? null,
  };
  return memberWrite(command, read, facts, [member], 'member-joined');
}

export function computeInvite(
  command: Extract<GroupMutationCommand, { operation: 'createGroupInvite' }>,
  read: GroupMutationRead,
  facts: GroupMutationFacts,
): GroupMutationComputed {
  requireGroup(read, command.aggregateRef);
  assertGovernance(command, read, facts, 'invite');
  const existing = findTargetMember(read);
  if (existing?.status === 'active') return noOp(command, read, facts);
  if (existing?.status === 'banned') {
    throw new GroupMutationRejectedError('Cannot invite a banned group member.');
  }
  const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
  const member: GroupMember = {
    ...command.aggregateRef,
    principalId: command.targetPrincipalId,
    role: existing?.role ?? 'member',
    status: 'invited',
    joined: null,
    updated: audit,
    left: null,
    removed: null,
    banned: null,
    invitedByPrincipalId: command.input.actorPrincipalId,
    invitationExpiresAtEpochMs: command.input.invitationExpiresAtEpochMs ?? facts.nowEpochMs + DEFAULT_GROUP_INVITE_TTL_MS,
  };
  return memberWrite(command, read, facts, [member], 'member-invited');
}

export function computeRevokeInvite(
  command: Extract<GroupMutationCommand, { targetPrincipalId: string }>,
  read: GroupMutationRead,
  facts: GroupMutationFacts,
): GroupMutationComputed {
  requireGroup(read, command.aggregateRef);
  assertGovernance(command, read, facts, 'remove');
  const existing = findTargetMember(read);
  if (existing?.status !== 'invited') return noOp(command, read, facts);
  const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
  return memberWrite(
    command,
    read,
    facts,
    [
      transitionMemberLifecycle(
        {
          ...existing,
          updated: audit,
        },
        'left',
        audit,
      ),
    ],
    'member-left',
  );
}

export function computeGovernedMember(
  command: Extract<GroupMutationCommand, { targetPrincipalId: string }>,
  read: GroupMutationRead,
  facts: GroupMutationFacts,
): GroupMutationComputed {
  requireGroup(read, command.aggregateRef);
  const action: GroupGovernanceAction =
    command.operation === 'banGroupMember' ? 'ban' : command.operation === 'unbanGroupMember' ? 'unban' : command.operation === 'setGroupMemberRole' ? 'promote' : 'remove';
  assertGovernance(command, read, facts, action);
  const existing = findTargetMember(read);
  if (!existing && command.operation === 'unbanGroupMember') return noOp(command, read, facts);
  if (!existing && command.operation === 'setGroupMemberRole') {
    throw new GroupMutationRejectedError(`Group member not found: ${command.targetPrincipalId}`);
  }
  const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
  const base: GroupMember = existing ?? {
    ...command.aggregateRef,
    principalId: command.targetPrincipalId,
    role: 'member',
    status: 'left',
    joined: null,
    updated: audit,
    left: audit,
    removed: null,
    banned: null,
    invitedByPrincipalId: null,
    invitationExpiresAtEpochMs: null,
  };
  const status =
    command.operation === 'banGroupMember' ? 'banned' : command.operation === 'unbanGroupMember' ? 'left' : command.operation === 'removeGroupMember' ? 'removed' : base.status;
  const role = command.operation === 'setGroupMemberRole' ? command.input.role : base.role;
  if (command.operation === 'setGroupMemberRole' && role === 'owner') {
    throw new GroupMutationRejectedError('Ownership can only change through transferGroupOwnership.');
  }
  if (command.operation === 'setGroupMemberRole' && role === 'admin' && read.actorMember?.role === 'admin' && base.role !== 'admin') {
    throw new GroupMutationRejectedError('Group admins cannot grant the admin role.');
  }
  if (base.status === status && base.role === role) return noOp(command, read, facts);
  assertNotLastOwner(requireGroup(read, command.aggregateRef).value, base, status, role);
  const member = transitionMemberLifecycle(
    {
      ...base,
      role,
      updated: audit,
    },
    status,
    audit,
  );
  const eventType: GroupEventType =
    command.operation === 'banGroupMember'
      ? 'member-banned'
      : command.operation === 'unbanGroupMember'
        ? 'member-unbanned'
        : command.operation === 'setGroupMemberRole'
          ? 'member-role-changed'
          : 'member-removed';
  return memberWrite(command, read, facts, [member], eventType);
}

export function computeTransfer(
  command: Extract<GroupMutationCommand, { operation: 'transferGroupOwnership' }>,
  read: GroupMutationRead,
  facts: GroupMutationFacts,
): GroupMutationComputed {
  requireGroup(read, command.aggregateRef);
  assertGovernance(command, read, facts, 'transfer-ownership');
  const actor = read.actorMember ?? undefined;
  const target = findTargetMember(read);
  if (!actor || actor.status !== 'active' || actor.role !== 'owner') {
    throw new GroupMutationRejectedError('Only an active owner can transfer ownership.');
  }
  if (!target || target.status !== 'active') {
    throw new GroupMutationRejectedError('Ownership target must be active.');
  }
  if (actor.principalId === target.principalId) return noOp(command, read, facts);
  const audit = auditStamp(command, facts, actor.principalId);
  return memberWrite(
    command,
    read,
    facts,
    [
      { ...actor, role: 'admin', updated: audit },
      { ...target, role: 'owner', updated: audit },
    ],
    'ownership-transferred',
  );
}

export function computeUpsertMember(
  command: Extract<GroupMutationCommand, { operation: 'upsertMember' }>,
  read: GroupMutationRead,
  facts: GroupMutationFacts,
): GroupMutationComputed {
  requireGroup(read, command.aggregateRef);
  const isSelf = command.input.actorPrincipalId === command.targetPrincipalId;
  if (!isSelf) {
    assertGovernance(command, read, facts, command.input.status === 'banned' ? 'ban' : 'promote');
  } else {
    assertPrincipalAuthority(command, command.targetPrincipalId);
    if (command.input.status !== 'active' && command.input.status !== 'left') {
      throw new GroupMutationRejectedError('Self upsert may only join or leave the group.');
    }
    if (command.input.role !== null && command.input.role !== (read.targetMember?.role ?? 'member')) {
      throw new GroupMutationRejectedError('Self upsert cannot change role.');
    }
  }
  if (command.input.role === 'owner') {
    throw new GroupMutationRejectedError('Ownership can only change through transferGroupOwnership.');
  }
  if (!isSelf && command.input.role === 'admin' && read.actorMember?.role === 'admin' && read.targetMember?.role !== 'admin') {
    throw new GroupMutationRejectedError('Group admins cannot grant the admin role.');
  }
  const snapshot = toPolicySnapshot(read, facts.nowEpochMs);
  if (command.input.status === 'active') {
    assertAllowed(
      command.input.actorPrincipalId === command.targetPrincipalId
        ? canJoinGroup({
            snapshot,
            actor: {
              principalId: command.input.actorPrincipalId ?? undefined,
              sessionId: command.input.actorSessionId ?? undefined,
            },
            nowEpochMs: facts.nowEpochMs,
          })
        : canActivateGroupMember({
            snapshot,
            targetPrincipalId: command.targetPrincipalId,
            nowEpochMs: facts.nowEpochMs,
          }),
    );
  }
  const existing = findTargetMember(read);
  const role = command.input.role ?? existing?.role ?? 'member';
  const invitedByPrincipalId = command.input.invitedByPrincipalId ?? existing?.invitedByPrincipalId ?? null;
  const invitationExpiresAtEpochMs = command.input.invitationExpiresAtEpochMs ?? existing?.invitationExpiresAtEpochMs ?? null;
  if (
    existing &&
    existing.status === command.input.status &&
    existing.role === role &&
    existing.invitedByPrincipalId === invitedByPrincipalId &&
    existing.invitationExpiresAtEpochMs === invitationExpiresAtEpochMs
  ) {
    return noOp(command, read, facts);
  }
  const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? command.targetPrincipalId);
  const member = transitionMemberLifecycle(
    {
      ...command.aggregateRef,
      principalId: command.targetPrincipalId,
      role,
      joined: existing?.joined ?? audit,
      updated: audit,
      left: existing?.left ?? null,
      removed: existing?.removed ?? null,
      banned: existing?.banned ?? null,
      invitedByPrincipalId,
      invitationExpiresAtEpochMs,
    },
    command.input.status,
    audit,
  );
  if (existing && jsonEquals(existing, member)) return noOp(command, read, facts);
  assertNotLastOwner(requireGroup(read, command.aggregateRef).value, existing, member.status, member.role);
  return memberWrite(command, read, facts, [member], memberEventType(member.status));
}

function memberWrite(
  command: GroupMutationCommand,
  read: GroupMutationRead,
  facts: GroupMutationFacts,
  members: readonly GroupMember[],
  eventType: GroupEventType,
): GroupMutationComputed {
  const stored = requireGroup(read, command.aggregateRef);
  const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
  let activeMemberCount = stored.value.activeMemberCount;
  for (const member of members) {
    const previous = findKnownMember(read, member.principalId);
    const previousActive = previous?.status === 'active';
    const nextActive = member.status === 'active';
    if (previousActive !== nextActive) {
      activeMemberCount += nextActive ? 1 : -1;
    }
  }
  if (!Number.isSafeInteger(activeMemberCount) || activeMemberCount < 0) {
    throw new TypeError('Group activeMemberCount delta is invalid');
  }
  const promotedOwner = members.find((member) => member.status === 'active' && member.role === 'owner');
  const ownerPrincipalId = eventType === 'ownership-transferred' ? promotedOwner?.principalId : stored.value.ownerPrincipalId;
  if (!ownerPrincipalId) {
    throw new TypeError('Group owner transition has no active owner');
  }
  for (const member of members) {
    if (member.principalId === ownerPrincipalId && (member.status !== 'active' || member.role !== 'owner')) {
      throw new GroupMutationRejectedError('Cannot remove or demote the active group owner.');
    }
    if (member.status === 'active' && member.role === 'owner' && member.principalId !== ownerPrincipalId) {
      throw new GroupMutationRejectedError('Ownership can only change through a single guarded transfer.');
    }
  }
  const group: Group = {
    ...stored.value,
    activeMemberCount,
    ownerPrincipalId,
    snapshotVersion: stored.value.snapshotVersion + 1,
    rosterVersion: stored.value.rosterVersion + 1,
    updated: audit,
  };
  return writeResult(command, read, facts, {
    guard: {
      kind: 'group',
      operation: 'update',
      value: group,
      expectedRevision: stored.entry.revision,
    },
    members,
    initialPresenceSummary: null,
    presenceAdmission: admissionForMemberWrite(read, members, facts),
    eventType,
  });
}

export function findKnownMember(read: GroupMutationRead, principalId: string): GroupMember | undefined {
  if (read.actorMember?.principalId === principalId) return read.actorMember;
  if (read.targetMember?.principalId === principalId) return read.targetMember;
  return undefined;
}

function findTargetMember(read: GroupMutationRead): GroupMember | undefined {
  return read.targetMember ?? undefined;
}

function transitionMemberLifecycle(
  member: Omit<GroupMember, 'status' | 'left' | 'removed' | 'banned'> &
    Readonly<{
      left: AuditStamp | null;
      removed: AuditStamp | null;
      banned: AuditStamp | null;
    }>,
  status: GroupMemberStatus,
  audit: AuditStamp,
): GroupMember {
  if (status === 'invited') {
    return {
      ...member,
      status,
      joined: null,
      left: null,
      removed: null,
      banned: null,
    };
  }
  if (status === 'active') {
    return {
      ...member,
      status,
      joined: member.joined ?? audit,
      left: null,
      removed: null,
      banned: null,
    };
  }
  if (status === 'left') {
    return { ...member, status, left: audit, removed: null, banned: null };
  }
  if (status === 'removed') {
    return { ...member, status, left: null, removed: audit, banned: null };
  }
  return { ...member, status, left: null, removed: null, banned: audit };
}

function memberEventType(status: GroupMemberStatus): GroupEventType {
  switch (status) {
    case 'invited':
      return 'member-invited';
    case 'active':
      return 'member-joined';
    case 'left':
      return 'member-left';
    case 'removed':
      return 'member-removed';
    case 'banned':
      return 'member-banned';
  }
}
