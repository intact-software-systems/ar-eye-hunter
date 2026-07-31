import type { GroupMember, GroupPresenceAdmission, GroupRef } from '@shared/api/group-types.ts';
import { GroupPolicyDeniedError } from '../../group-policy.ts';

import type { GroupMutationCommand, GroupMutationFacts, GroupMutationRead, PresenceAdmissionCandidate } from './group-mutation-contracts.ts';
import { validatePresenceAdmission } from '../persistence/validate-persisted-group-presence.ts';
export function assertPrincipalAuthority(command: GroupMutationCommand, principalId: string): void {
  if (command.input.actorPrincipalId !== principalId) {
    throw new GroupPolicyDeniedError({
      allowed: false,
      code: 'member-not-active',
      message: 'Mutation actor must match the authoritative principal.',
    });
  }
}

export function admissionForMemberWrite(
  read: GroupMutationRead,
  members: readonly GroupMember[],
  facts: GroupMutationFacts,
): PresenceAdmissionCandidate | null {
  const current = read.targetAdmission;
  const target = members.find((member) => member.status !== 'active');
  if (!target) return null;
  if (current) {
    validatePresenceAdmission(current.value);
    if (current.value.principalId !== target.principalId) {
      throw new TypeError('Presence admission predecessor differs from member authority target');
    }
  }
  const previousUpdatedAt = current?.value.updatedAtEpochMs ?? 0;
  if (previousUpdatedAt >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError('Presence admission fence timestamp cannot advance');
  }
  const value: GroupPresenceAdmission = {
    ...commandRefForAdmission(target),
    admittedSessions: [],
    updatedAtEpochMs: Math.max(previousUpdatedAt + 1, facts.nowEpochMs),
  };
  validatePresenceAdmission(value);
  return current
    ? {
        operation: 'update',
        value,
        expectedRevision: current.entry.revision,
      }
    : { operation: 'insert', value };
}

function commandRefForAdmission(member: GroupMember): GroupRef & Readonly<{ principalId: string }> {
  return {
    applicationId: member.applicationId,
    workspaceId: member.workspaceId,
    groupId: member.groupId,
    principalId: member.principalId,
  };
}
