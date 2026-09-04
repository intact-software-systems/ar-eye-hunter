import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { computeGroupFormationReading } from '@shared/api/group-lifecycle/compute-group-formation-reading.ts';
import { evaluateGroupActivationCriterion } from '@shared/api/group-lifecycle/evaluate-group-activation-criterion.ts';
import { toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { consumesFormationDeadlineAt } from '@shared/api/group-lifecycle/resolve-formation-stage-entry.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import {
    toFailFormationCommand,
    toFormationActivateCommand
} from '../../../group-state/group-formation-mutation-command.ts';
import type { GroupMutationCommand } from '../../../group-state/mutation/group-mutation-contracts.ts';
import {
    toReadGroupLifecyclePolicy,
    type GroupLifecyclePolicyRead
} from '../../../group-state/persistence/group-lifecycle-policy-repository.ts';

export interface ComputeFormationCriterionCommandInput {
    readonly group: GroupSnapshot;
    readonly planned: RallarOverlayTopologySnapshot;
    readonly rttMeasurements: readonly RttMeasurementInfo[];
    readonly nowEpochMs: number;
    readonly lifecyclePolicy: GroupLifecyclePolicyRead;
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
export function computeFormationCriterionCommand(
    input: ComputeFormationCriterionCommandInput
): GroupMutationCommand | null {
    const group = input.group.group;
    if (!consumesFormationDeadlineAt(group.lifecycleState)) {
        return null;
    }
    if (input.planned.state !== 'active') {
        // A removed plan never petitions, from any leg: its empty edge set
        // reads as trivially-complete readiness, which would activate a group
        // against a torn-down layout at rate 1.
        return null;
    }
    const policy = toReadGroupLifecyclePolicy(input.lifecyclePolicy);
    if (policy === null) {
        return null;
    }
    const reading = computeGroupFormationReading({
        planned: input.planned,
        rttMeasurements: input.rttMeasurements,
        nowEpochMs: input.nowEpochMs
    });
    const decision = evaluateGroupActivationCriterion({
        activation: policy.activation,
        observedRate: reading.readiness.observedRate,
        establishmentStartedAtEpochMs: group.establishmentStartedAtEpochMs,
        formationAttemptCount: group.formationAttemptCount,
        nowEpochMs: input.nowEpochMs
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
                    groupId: group.groupId
                },
                formationEpoch: group.formationEpoch,
                observedRate: reading.readiness.observedRate,
                degraded: decision.decision === 'activate-degraded',
                expectedLayout: toGroupLayoutIdentity(input.planned)
            });
        case 'below-floor':
            return toFailFormationCommand({
                groupRef: {
                    applicationId: group.applicationId,
                    workspaceId: group.workspaceId,
                    groupId: group.groupId
                },
                formationEpoch: group.formationEpoch,
                observedRate: reading.readiness.observedRate,
                expectedLayout: toGroupLayoutIdentity(input.planned)
            });
    }
}
