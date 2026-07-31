import type {
  GroupMember,
  GroupPresenceAdmission,
  GroupPresenceSession,
  GroupRef,
} from '@shared/api/group-types.ts';
import { GroupPolicyDeniedError } from '../../../group-policy.ts';

import type {
  GroupMutationCommand,
  GroupMutationFacts,
  GroupMutationRead,
  PresenceAdmissionCandidate,
} from '../group-mutation-contracts.ts';
import { isExactlyAdmitted } from '../aggregate/group-aggregate-mutation-policy.ts';
import { requireGroup } from '../group-mutation-result.ts';
import { validatePresenceAdmission } from '../../persistence/validate-persisted-group-presence.ts';

interface ComputeMemberPresenceAdmissionInput {
  readonly read: GroupMutationRead;
  readonly members: readonly GroupMember[];
  readonly facts: GroupMutationFacts;
}

interface ComputeConnectPresenceAdmissionInput {
  readonly command: Extract<GroupMutationCommand, { operation: 'connectPresence' }>;
  readonly read: GroupMutationRead;
  readonly session: GroupPresenceSession;
  readonly facts: GroupMutationFacts;
}

interface ComputeDisconnectPresenceAdmissionInput {
  readonly read: GroupMutationRead;
  readonly session: GroupPresenceSession;
  readonly facts: GroupMutationFacts;
}

export function computeMemberPresenceAdmission({
  read,
  members,
  facts,
}: ComputeMemberPresenceAdmissionInput): PresenceAdmissionCandidate | null {
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
    ...presenceAdmissionRef(target),
    admittedSessions: [],
    updatedAtEpochMs: Math.max(previousUpdatedAt + 1, facts.nowEpochMs),
  };
  validatePresenceAdmission(value);
  return current
    ? { operation: 'update', value, expectedRevision: current.entry.revision }
    : { operation: 'insert', value };
}

export function computeConnectPresenceAdmission({
  command,
  read,
  session,
  facts,
}: ComputeConnectPresenceAdmissionInput): PresenceAdmissionCandidate {
  const current = read.targetAdmission;
  if (current) validatePresenceAdmission(current.value);
  const retained = (current?.value.admittedSessions ?? []).filter(
    (entry) => entry.sessionId !== session.sessionId,
  );
  const admittedSessions = [
    ...retained,
    {
      sessionId: session.sessionId,
      generationId: session.generationId,
      generationVersion: session.generationVersion,
      connectedAtEpochMs: session.connectedAtEpochMs,
    },
  ].toSorted((left, right) => left.sessionId.localeCompare(right.sessionId));
  const cap = requireGroup(read, command.aggregateRef).value.maxSessionsPerMember;
  if (cap !== null && admittedSessions.length > cap) {
    throw new GroupPolicyDeniedError({
      allowed: false,
      code: 'member-session-limit-reached',
      message: 'Group member session capacity has been reached.',
    });
  }
  const value: GroupPresenceAdmission = {
    ...command.aggregateRef,
    principalId: session.principalId,
    admittedSessions,
    updatedAtEpochMs: Math.max(current?.value.updatedAtEpochMs ?? 0, facts.nowEpochMs),
  };
  validatePresenceAdmission(value);
  return current
    ? { operation: 'update', value, expectedRevision: current.entry.revision }
    : { operation: 'insert', value };
}

export function computeDisconnectPresenceAdmission({
  read,
  session,
  facts,
}: ComputeDisconnectPresenceAdmissionInput): PresenceAdmissionCandidate | null {
  const current = read.targetAdmission;
  if (!current || !isExactlyAdmitted(current.value, session)) return null;
  const value: GroupPresenceAdmission = {
    ...current.value,
    admittedSessions: current.value.admittedSessions.filter(
      (entry) => entry.sessionId !== session.sessionId,
    ),
    updatedAtEpochMs: Math.max(current.value.updatedAtEpochMs, facts.nowEpochMs),
  };
  validatePresenceAdmission(value);
  return { operation: 'update', value, expectedRevision: current.entry.revision };
}

export function presenceAdmissionIdentity(
  principalId: string,
  session: Pick<GroupPresenceSession, 'sessionId' | 'generationId' | 'generationVersion'>,
): string {
  return JSON.stringify([
    principalId,
    session.sessionId,
    session.generationId,
    session.generationVersion,
  ]);
}

function presenceAdmissionRef(member: GroupMember): GroupRef & Readonly<{ principalId: string }> {
  return {
    applicationId: member.applicationId,
    workspaceId: member.workspaceId,
    groupId: member.groupId,
    principalId: member.principalId,
  };
}
