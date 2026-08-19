import type {
  AuditStamp,
  GroupEventType,
  GroupMember,
  GroupMemberStatus,
} from '@shared/api/group-types.ts';

import type { GroupMutationCommand, GroupMutationFacts } from '../group-mutation-contracts.ts';
import { auditStamp } from '../group-mutation-result.ts';

type GroupMemberLifecycleInput = Omit<GroupMember, 'status' | 'left' | 'removed' | 'banned'> &
  Readonly<{
    left: AuditStamp | null;
    removed: AuditStamp | null;
    banned: AuditStamp | null;
  }>;

interface CreateUpsertGroupMemberInput {
  readonly command: Extract<GroupMutationCommand, { operation: 'upsertMember' }>;
  readonly facts: GroupMutationFacts;
  readonly existing: GroupMember | undefined;
  readonly role: GroupMember['role'];
  readonly invitedByPrincipalId: string | null;
  readonly invitationExpiresAtEpochMs: number | null;
}

export function createUpsertGroupMember({
  command,
  facts,
  existing,
  role,
  invitedByPrincipalId,
  invitationExpiresAtEpochMs,
}: CreateUpsertGroupMemberInput): GroupMember {
  const audit = auditStamp(
    command,
    facts,
    command.input.actorPrincipalId ?? command.targetPrincipalId,
  );
  return transitionGroupMemberLifecycle(
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
}

export function transitionGroupMemberLifecycle(
  member: GroupMemberLifecycleInput,
  status: GroupMemberStatus,
  audit: AuditStamp,
): GroupMember {
  if (status === 'invited' || status === 'pending') {
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

export function groupMemberEventType(status: GroupMemberStatus): GroupEventType {
  switch (status) {
    case 'invited':
      return 'member-invited';
    case 'pending':
      return 'member-admission-requested';
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
