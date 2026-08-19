import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { computeGroupFormationReadiness } from '@shared/api/group-lifecycle/compute-group-formation-readiness.ts';
import { evaluateGroupActivationCriterion } from '@shared/api/group-lifecycle/evaluate-group-activation-criterion.ts';
import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import {
  toFailFormationCommand,
  toFormationActivateCommand,
} from '../../group-state/group-formation-mutation-command.ts';
import type { GroupMutationCommand } from '../../group-state/mutation/group-mutation-contracts.ts';
import type { GroupLifecyclePolicyRead } from '../../group-state/persistence/group-lifecycle-policy-repository.ts';

export interface ComputeFormationCriterionCommandInput {
  readonly group: GroupSnapshot;
  readonly planned: RallarOverlayTopologySnapshot;
  readonly rttMeasurements: readonly RttMeasurementInfo[];
  readonly nowEpochMs: number;
  readonly readLifecyclePolicy: (ref: GroupRef) => Promise<GroupLifecyclePolicyRead>;
}

/**
 * Observation petitions intent, and nothing more: this derives readiness from
 * the just-planned overlay, evaluates the activation criterion, and returns
 * the transition command the criterion asks for -- or null. The command
 * re-authorizes through AppInbox with fresh state, so a stale petition is a
 * replay or a typed rejection, never a wrong transition. A corrupt stored
 * policy returns null: automation must fail closed, matching the transition
 * compute's own posture.
 */
export async function computeFormationCriterionCommand(
  input: ComputeFormationCriterionCommandInput,
): Promise<GroupMutationCommand | null> {
  const group = input.group.group;
  if (group.lifecycleState !== 'establishing' && group.lifecycleState !== 'reconfiguring') {
    return null;
  }
  const policyRead = await input.readLifecyclePolicy(group);
  if (policyRead.status === 'corrupt') {
    return null;
  }
  const policy =
    policyRead.status === 'present' ? policyRead.policy : createDefaultGroupLifecyclePolicy();
  const readiness = computeGroupFormationReadiness({
    planned: input.planned,
    rttMeasurements: input.rttMeasurements,
    nowEpochMs: input.nowEpochMs,
  });
  const decision = evaluateGroupActivationCriterion({
    activation: policy.activation,
    observedRate: readiness.observedRate,
    establishmentStartedAtEpochMs: group.establishmentStartedAtEpochMs,
    formationAttemptCount: group.formationAttemptCount,
    nowEpochMs: input.nowEpochMs,
  });
  switch (decision.decision) {
    case 'wait':
      return null;
    case 'activate':
    case 'activate-degraded':
      return toFormationActivateCommand({
        groupRef: {
          applicationId: group.applicationId,
          workspaceId: group.workspaceId,
          groupId: group.groupId,
        },
        formationEpoch: group.formationEpoch,
        observedRate: readiness.observedRate,
        degraded: decision.decision === 'activate-degraded',
      });
    case 'below-floor':
      return toFailFormationCommand({
        groupRef: {
          applicationId: group.applicationId,
          workspaceId: group.workspaceId,
          groupId: group.groupId,
        },
        formationEpoch: group.formationEpoch,
        observedRate: readiness.observedRate,
      });
  }
}
