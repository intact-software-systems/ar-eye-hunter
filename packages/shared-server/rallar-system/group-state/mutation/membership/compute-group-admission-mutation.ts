import type { GroupMember } from '@shared/api/group-types.ts';
// prettier-ignore
import type {
  GroupLifecyclePolicy,
} from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
// prettier-ignore
import {
  computeGroupAdmissionDecision,
} from '@shared/api/group-lifecycle/compute-group-admission-decision.ts';
// prettier-ignore
import {
  createDefaultGroupLifecyclePolicy,
} from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import {
  canActivateGroupMember,
  canDecideGroupAdmission,
  GroupPolicyDeniedError,
  type GroupPolicyActor,
} from '../../../group-policy.ts';

import type {
  GroupMutationCommand,
  GroupMutationComputed,
  GroupMutationFacts,
  GroupMutationRead,
} from '../group-mutation-contracts.ts';
import { GroupMutationRejectedError } from '../group-mutation-contracts.ts';
import { assertAllowed, toPolicySnapshot } from '../aggregate/group-aggregate-mutation-policy.ts';
import { auditStamp, noOp, requireGroup } from '../group-mutation-result.ts';
import { computeGroupMembershipWrite } from '../write/compute-group-membership-write.ts';
import { transitionGroupMemberLifecycle } from './transition-group-member-lifecycle.ts';

interface ResolveAdmittedMemberStatusInput {
  readonly read: GroupMutationRead;
  readonly facts: GroupMutationFacts;
  readonly existing: GroupMember | undefined;
}

/**
 * The landing status for a join that already passed `canJoinGroup` (plan
 * decision 5.1): under `manager-approval` an uninvited join parks as
 * `pending`; an unexpired invite is the group's consent and completes to
 * `active`. Closed modes and the admission windows deny here as typed policy
 * denials. Both join surfaces — the join command and self-upsert activation —
 * resolve through this one function.
 */
export function resolveAdmittedMemberStatus(
  input: ResolveAdmittedMemberStatusInput,
): 'active' | 'pending' {
  if (input.read.group === null) {
    throw new GroupMutationRejectedError('Group not found');
  }
  const group = input.read.group.value;
  const policy = requireReadableLifecyclePolicy(input.read);
  const decision = computeGroupAdmissionDecision({
    admission: policy.admission,
    lifecycleState: group.lifecycleState,
    activeMemberCount: group.activeMemberCount,
    invited: isUnexpiredInvite(input.existing, input.facts.nowEpochMs),
    nowEpochMs: input.facts.nowEpochMs,
  });
  if (decision.kind === 'deny') throw new GroupPolicyDeniedError(decision.denial);
  return decision.kind === 'park' ? 'pending' : 'active';
}

export function computeGrantGroupAdmission(
  command: Extract<GroupMutationCommand, { targetPrincipalId: string }>,
  read: GroupMutationRead,
  facts: GroupMutationFacts,
): GroupMutationComputed {
  const stored = requireGroup(read, command.aggregateRef);
  const policy = requireReadableLifecyclePolicy(read);
  const snapshot = toPolicySnapshot(read, facts.nowEpochMs);
  assertAllowed(
    canDecideGroupAdmission({
      snapshot,
      actor: toCommandActor(command),
      policy,
      activeMemberPrincipalIds: requireAdmissionRoster(read),
      nowEpochMs: facts.nowEpochMs,
    }),
  );
  const existing = read.targetMember ?? undefined;
  if (existing?.status === 'active') return noOp(command, read, facts);
  if (existing?.status !== 'pending') {
    throw new GroupMutationRejectedError(
      `No pending admission for group member: ${command.targetPrincipalId}`,
    );
  }
  // The group's consent lands second, in a fresh attempt: capacity and the
  // admission windows are re-checked at grant time, not at parking time.
  assertAllowed(
    canActivateGroupMember({
      snapshot,
      targetPrincipalId: command.targetPrincipalId,
      nowEpochMs: facts.nowEpochMs,
      capacity: facts.capacity,
    }),
  );
  const windows = computeGroupAdmissionDecision({
    admission: policy.admission,
    lifecycleState: stored.value.lifecycleState,
    activeMemberCount: stored.value.activeMemberCount,
    invited: true,
    nowEpochMs: facts.nowEpochMs,
  });
  if (windows.kind === 'deny') throw new GroupPolicyDeniedError(windows.denial);
  const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
  return computeGroupMembershipWrite({
    command,
    read,
    facts,
    members: [transitionGroupMemberLifecycle({ ...existing, updated: audit }, 'active', audit)],
    eventType: 'member-joined',
  });
}

export function computeDeclineGroupAdmission(
  command: Extract<GroupMutationCommand, { targetPrincipalId: string }>,
  read: GroupMutationRead,
  facts: GroupMutationFacts,
): GroupMutationComputed {
  requireGroup(read, command.aggregateRef);
  const policy = requireReadableLifecyclePolicy(read);
  assertAllowed(
    canDecideGroupAdmission({
      snapshot: toPolicySnapshot(read, facts.nowEpochMs),
      actor: toCommandActor(command),
      policy,
      activeMemberPrincipalIds: requireAdmissionRoster(read),
      nowEpochMs: facts.nowEpochMs,
    }),
  );
  const existing = read.targetMember ?? undefined;
  // Decline mirrors invite revoke: the parked row lands `left`, so the
  // principal may re-request; `banned` remains the keep-out tool.
  if (existing?.status !== 'pending') return noOp(command, read, facts);
  const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
  return computeGroupMembershipWrite({
    command,
    read,
    facts,
    members: [transitionGroupMemberLifecycle({ ...existing, updated: audit }, 'left', audit)],
    eventType: 'member-left',
  });
}

function requireReadableLifecyclePolicy(read: GroupMutationRead): GroupLifecyclePolicy {
  if (read.lifecyclePolicy === null) {
    throw new TypeError('Admission compute requires the lifecycle policy read');
  }
  if (read.lifecyclePolicy.status === 'corrupt') {
    // Fail closed: an unreadable stored policy must not read as permissive.
    throw new GroupMutationRejectedError(
      `Group lifecycle policy is unreadable: ${read.lifecyclePolicy.reason}`,
    );
  }
  return read.lifecyclePolicy.status === 'present'
    ? read.lifecyclePolicy.policy
    : createDefaultGroupLifecyclePolicy();
}

function requireAdmissionRoster(read: GroupMutationRead): readonly string[] {
  if (read.activeMemberPrincipalIds === null) {
    throw new TypeError('Admission decision compute requires the roster read');
  }
  return read.activeMemberPrincipalIds;
}

function isUnexpiredInvite(existing: GroupMember | undefined, nowEpochMs: number): boolean {
  return (
    existing?.status === 'invited' &&
    (existing.invitationExpiresAtEpochMs === null ||
      existing.invitationExpiresAtEpochMs > nowEpochMs)
  );
}

function toCommandActor(
  command: Extract<GroupMutationCommand, { targetPrincipalId: string }>,
): GroupPolicyActor {
  return {
    principalId: command.input.actorPrincipalId ?? undefined,
    sessionId: command.input.actorSessionId ?? undefined,
  };
}
