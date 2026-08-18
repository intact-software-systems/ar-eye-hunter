// prettier-ignore
import {
  createDefaultGroupLifecyclePolicy,
} from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import {
  computeGroupLifecycleTransition,
  type GroupLifecycleTransition,
} from '@shared/api/group-lifecycle/group-lifecycle-transitions.ts';
import type { Group } from '@shared/api/group-types.ts';

import {
  canCommandGroupLifecycleTransition,
  GroupPolicyDeniedError,
} from '../../../group-policy.ts';
import type {
  GroupLifecycleTransitionOperation,
  GroupMutationCommand,
  GroupMutationComputed,
  GroupMutationFacts,
  GroupMutationRead,
} from '../group-mutation-contracts.ts';
import {
  auditStamp,
  computeGroupMutationWriteResult,
  rejected,
  requireGroup,
} from '../group-mutation-result.ts';
import {
  assertActive,
  assertAllowed,
  toPolicySnapshot,
} from './group-aggregate-mutation-policy.ts';

const LIFECYCLE_TRANSITION_BY_OPERATION = {
  startGroupEstablishment: 'start-establishment',
  activateGroup: 'activate',
  reopenGroupEstablishment: 'reopen-establishment',
} as const satisfies Record<GroupLifecycleTransitionOperation, GroupLifecycleTransition>;

export function computeLifecycleTransition(
  command: Extract<GroupMutationCommand, { operation: GroupLifecycleTransitionOperation }>,
  read: GroupMutationRead,
  facts: GroupMutationFacts,
): GroupMutationComputed {
  const stored = requireGroup(read, command.aggregateRef);
  assertActive(stored.value, facts.nowEpochMs);
  if (read.lifecyclePolicy === null) {
    throw new TypeError('Lifecycle transition compute requires the policy read');
  }
  if (read.lifecyclePolicy.status === 'corrupt') {
    // Fail closed: an unreadable stored policy must not read as permissive.
    return rejected({
      command,
      read,
      facts,
      message: `Group lifecycle policy is unreadable: ${read.lifecyclePolicy.reason}`,
    });
  }
  const policy =
    read.lifecyclePolicy.status === 'present'
      ? read.lifecyclePolicy.policy
      : createDefaultGroupLifecyclePolicy();
  const transition = LIFECYCLE_TRANSITION_BY_OPERATION[command.operation];
  assertAllowed(
    canCommandGroupLifecycleTransition({
      snapshot: toPolicySnapshot(read, facts.nowEpochMs),
      actor: {
        principalId: command.input.actorPrincipalId ?? undefined,
        sessionId: command.input.actorSessionId ?? undefined,
      },
      policy,
      transition,
    }),
  );
  const outcome = computeGroupLifecycleTransition({
    transition,
    lifecycleState: stored.value.lifecycleState,
    formationEpoch: stored.value.formationEpoch,
  });
  if (!outcome.allowed) throw new GroupPolicyDeniedError(outcome);
  const next: Group = {
    ...stored.value,
    lifecycleState: outcome.nextState,
    formationEpoch: outcome.nextFormationEpoch,
    snapshotVersion: stored.value.snapshotVersion + 1,
    updated: auditStamp(command, facts, command.input.actorPrincipalId ?? undefined),
  };
  return computeGroupMutationWriteResult({
    command,
    read,
    facts,
    guard: {
      kind: 'group',
      operation: 'update',
      value: next,
      expectedRevision: stored.entry.revision,
    },
    members: [],
    initialPresenceSummary: null,
    presenceAdmission: null,
    eventType: 'group-updated',
    presenceSummaryWork: 'enqueue',
  });
}
