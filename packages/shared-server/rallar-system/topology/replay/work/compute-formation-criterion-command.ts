import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { computeGroupFormationReadiness } from '@shared/api/group-lifecycle/compute-group-formation-readiness.ts';
import { evaluateGroupActivationCriterion } from '@shared/api/group-lifecycle/evaluate-group-activation-criterion.ts';
import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import { toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';
import { fromCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import {
    toFailFormationCommand,
    toFormationActivateCommand
} from '../../../group-state/group-formation-mutation-command.ts';
import type { GroupMutationCommand } from '../../../group-state/mutation/group-mutation-contracts.ts';
import type { GroupLifecyclePolicyRead } from '../../../group-state/persistence/group-lifecycle-policy-repository.ts';

import type { RtcTopologyExecutionRepository } from '../../persistence/rtc-topology-execution-repository.ts';
import type { GroupTopologyPlanningAuthority } from '../../planning/group-topology-planning-authority.ts';
import type { GroupTopologyPlanningService } from '../../planning/group-topology-planning-service.ts';
import type { PersistedRtcTopologyWork } from './rtc-topology-work-codec.ts';

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
    input: ComputeFormationCriterionCommandInput
): Promise<GroupMutationCommand | null> {
    const group = input.group.group;
    if (group.lifecycleState !== 'connecting' && group.lifecycleState !== 'reconfiguring') {
        return null;
    }
    const policyRead = await input.readLifecyclePolicy(group);
    if (policyRead.status === 'corrupt') {
        return null;
    }
    const policy = policyRead.status === 'present' ? policyRead.policy : createDefaultGroupLifecyclePolicy();
    const readiness = computeGroupFormationReadiness({
        planned: input.planned,
        rttMeasurements: input.rttMeasurements,
        nowEpochMs: input.nowEpochMs
    });
    const decision = evaluateGroupActivationCriterion({
        activation: policy.activation,
        observedRate: readiness.observedRate,
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
                observedRate: readiness.observedRate,
                degraded: decision.decision === 'activate-degraded'
            });
        case 'below-floor':
            return toFailFormationCommand({
                groupRef: {
                    applicationId: group.applicationId,
                    workspaceId: group.workspaceId,
                    groupId: group.groupId
                },
                formationEpoch: group.formationEpoch,
                observedRate: readiness.observedRate
            });
    }
}

export const DEFAULT_DEFERRED_CRITERION_PETITION_MIN_INTERVAL_MS = 1_000;

export interface FormationCriterionPort {
    readonly readLifecyclePolicy: (ref: GroupRef) => Promise<GroupLifecyclePolicyRead>;
    readonly submitCommand: (command: GroupMutationCommand, atEpochMs: number) => Promise<void>;
}

export interface DeferredCriterionPetitionDependencies {
    readonly topologyPlanning: Pick<GroupTopologyPlanningService, 'readTopologyPlanningAuthority'>;
    readonly executionRepository: Pick<RtcTopologyExecutionRepository, 'readTopologyMutation'>;
    readonly formationCriterion?: FormationCriterionPort;
    readonly criterionPetitionMinIntervalMs?: number;
}

type DeferredPetitionRead = Awaited<ReturnType<RtcTopologyExecutionRepository['readTopologyMutation']>>;

export interface DeferredCriterionPetitioner {
    request(work: PersistedRtcTopologyWork, read: DeferredPetitionRead): Promise<void>;
}

/**
 * The evidence leg of the activation criterion: observation petitions intent
 * and the petitioned command re-authorizes through AppInbox with fresh state,
 * so a stale petition is a replay or a typed rejection, never a wrong
 * transition.
 */
export async function petitionFormationCriterion(
    dependencies: DeferredCriterionPetitionDependencies,
    authority: GroupTopologyPlanningAuthority,
    planned: RallarOverlayTopologySnapshot
): Promise<void> {
    if (!dependencies.formationCriterion) {
        return;
    }
    const command = await computeFormationCriterionCommand({
        group: authority.group,
        planned,
        rttMeasurements: authority.rttMeasurements,
        nowEpochMs: authority.nowEpochMs,
        readLifecyclePolicy: dependencies.formationCriterion.readLifecyclePolicy
    });
    if (command === null) {
        return;
    }
    await dependencies.formationCriterion.submitCommand(command, authority.nowEpochMs);
}

/**
 * Process-local damping for criterion petitions from refinement-deferred RTT
 * work: a burst petitions at most once per interval per group, so deferred
 * work items stay cheap while the measurement that crosses the threshold
 * still activates the group within the interval. Damped requests arm one
 * trailing timer per group, because the crossing measurement lives at the
 * burst's tail by construction — leading-edge damping alone would defer the
 * decisive petition forever. The trailing petition is best-effort and only
 * warns on failure: the deadline evaluation stays the correctness backstop.
 * A removed stored plan never petitions — its empty edge set would read as
 * trivially-complete readiness.
 */
export function createDeferredCriterionPetitioner(
    dependencies: DeferredCriterionPetitionDependencies
): DeferredCriterionPetitioner {
    const minIntervalMs = dependencies.criterionPetitionMinIntervalMs ??
        DEFAULT_DEFERRED_CRITERION_PETITION_MIN_INTERVAL_MS;
    const lastPetitionAtByGroupKey = new Map<string, number>();
    const trailingByGroupKey = new Map<string, PersistedRtcTopologyWork>();

    const petition = async (
        work: PersistedRtcTopologyWork,
        planned: RallarOverlayTopologySnapshot
    ) => {
        const authority = await dependencies.topologyPlanning.readTopologyPlanningAuthority({
            groupRef: work.groupSnapshot.group,
            requestOptions: fromCanonicalGroupTopologyConfigPatch(work.requestOptions),
            knownGroup: work.groupSnapshot,
            snapshotSelection: 'prefer-current'
        });
        await petitionFormationCriterion(dependencies, authority, planned);
    };

    const flushTrailing = async (groupKey: string) => {
        const work = trailingByGroupKey.get(groupKey);
        trailingByGroupKey.delete(groupKey);
        if (!work) {
            return;
        }
        lastPetitionAtByGroupKey.set(groupKey, Date.now());
        try {
            const read = await dependencies.executionRepository.readTopologyMutation(
                work.groupSnapshot.group,
                null
            );
            if (read.snapshot !== null && read.snapshot.value.state === 'active') {
                await petition(work, read.snapshot.value);
            }
        }
        catch (error) {
            console.warn(
                `Deferred criterion petition failed for ${groupKey}: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }
    };

    return {
        async request(work, read) {
            if (
                work.groupSnapshot.group.lifecycleState !== 'connecting' ||
                read.snapshot === null ||
                read.snapshot.value.state !== 'active'
            ) {
                return;
            }
            const groupKey = toWebRtcGroupKey(work.groupSnapshot.group);
            const nowEpochMs = Date.now();
            const lastPetitionAt = lastPetitionAtByGroupKey.get(groupKey);
            if (lastPetitionAt !== undefined && nowEpochMs - lastPetitionAt < minIntervalMs) {
                const armTrailing = !trailingByGroupKey.has(groupKey);
                trailingByGroupKey.set(groupKey, work);
                if (armTrailing) {
                    setTimeout(() => {
                        void flushTrailing(groupKey);
                    }, lastPetitionAt + minIntervalMs - nowEpochMs);
                }
                return;
            }
            lastPetitionAtByGroupKey.set(groupKey, nowEpochMs);
            await petition(work, read.snapshot.value);
        }
    };
}
