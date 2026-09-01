import { toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';
import { consumesFormationDeadlineAt } from '@shared/api/group-lifecycle/resolve-formation-stage-entry.ts';
import { fromCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { GroupMutationCommand } from '../../../group-state/mutation/group-mutation-contracts.ts';
import type { GroupLifecyclePolicyRead } from '../../../group-state/persistence/group-lifecycle-policy-repository.ts';
import type { RtcTopologyMutationRead } from '../../mutation/rtc-topology-mutations.ts';
import type { RtcTopologyExecutionRepository } from '../../persistence/rtc-topology-execution-repository.ts';
import type { GroupTopologyPlanningAuthority } from '../../planning/group-topology-planning-authority.ts';
import type { GroupTopologyPlanningService } from '../../planning/group-topology-planning-service.ts';
import { computeFormationCriterionCommand } from './compute-formation-criterion-command.ts';
import type { PersistedRtcTopologyWork } from './rtc-topology-work-codec.ts';

export interface FormationCriterionPort {
    readonly readLifecyclePolicy: (ref: GroupRef) => Promise<GroupLifecyclePolicyRead>;
    readonly submitCommand: (command: GroupMutationCommand, atEpochMs: number) => Promise<void>;
    /** Process-local observation damping. Zero evaluates every deferred item. */
    readonly deferred: Readonly<{
        minIntervalMs: number;
        nowEpochMs: () => number;
        schedule: (delayMs: number, callback: () => Promise<void>) => void;
    }>;
}

export interface DeferredCriterionPetitionDependencies {
    readonly topologyPlanning: Pick<GroupTopologyPlanningService, 'readTopologyPlanningAuthority'>;
    readonly executionRepository: Pick<RtcTopologyExecutionRepository, 'readTopologyMutation'>;
    readonly formationCriterion?: FormationCriterionPort;
}

export interface DeferredCriterionPetitioner {
    request(work: PersistedRtcTopologyWork, read: RtcTopologyMutationRead): Promise<void>;
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
    if (
        !dependencies.formationCriterion ||
        !consumesFormationDeadlineAt(authority.group.group.lifecycleState) ||
        planned.state !== 'active'
    ) {
        return;
    }
    const lifecyclePolicy = await dependencies.formationCriterion.readLifecyclePolicy(authority.group.group);
    const command = computeFormationCriterionCommand({
        group: authority.group,
        planned,
        rttMeasurements: authority.rttMeasurements,
        nowEpochMs: authority.nowEpochMs,
        lifecyclePolicy
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
): DeferredCriterionPetitioner | null {
    return dependencies.formationCriterion
        ? new DeferredFormationCriterionPetitioner(dependencies, dependencies.formationCriterion)
        : null;
}

class DeferredFormationCriterionPetitioner implements DeferredCriterionPetitioner {
    private readonly lastPetitionAtByGroupKey = new Map<string, number>();
    private readonly trailingByGroupKey = new Map<string, PersistedRtcTopologyWork>();
    private readonly dependencies: DeferredCriterionPetitionDependencies;
    private readonly criterion: FormationCriterionPort;

    constructor(
        dependencies: DeferredCriterionPetitionDependencies,
        criterion: FormationCriterionPort
    ) {
        this.dependencies = dependencies;
        this.criterion = criterion;
    }

    private async petition(
        work: PersistedRtcTopologyWork,
        planned: RallarOverlayTopologySnapshot
    ): Promise<void> {
        const authority = await this.dependencies.topologyPlanning.readTopologyPlanningAuthority({
            groupRef: work.groupSnapshot.group,
            requestOptions: fromCanonicalGroupTopologyConfigPatch(work.requestOptions),
            knownGroup: work.groupSnapshot,
            snapshotSelection: 'prefer-current'
        });
        await petitionFormationCriterion(this.dependencies, authority, planned);
    }

    private async flushTrailing(groupKey: string): Promise<void> {
        const work = this.trailingByGroupKey.get(groupKey);
        this.trailingByGroupKey.delete(groupKey);
        if (!work) {
            return;
        }
        this.lastPetitionAtByGroupKey.set(groupKey, this.criterion.deferred.nowEpochMs());
        try {
            const read = await this.dependencies.executionRepository.readTopologyMutation(
                work.groupSnapshot.group,
                null
            );
            if (read.snapshot !== null && read.snapshot.value.state === 'active') {
                await this.petition(work, read.snapshot.value);
            }
        }
        catch (error) {
            console.warn(
                `Deferred criterion petition failed for ${groupKey}: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }
    }

    async request(work: PersistedRtcTopologyWork, read: RtcTopologyMutationRead): Promise<void> {
        if (
            !consumesFormationDeadlineAt(work.groupSnapshot.group.lifecycleState) ||
            read.snapshot === null ||
            read.snapshot.value.state !== 'active'
        ) {
            return;
        }
        const groupKey = toWebRtcGroupKey(work.groupSnapshot.group);
        const nowEpochMs = this.criterion.deferred.nowEpochMs();
        const lastPetitionAt = this.lastPetitionAtByGroupKey.get(groupKey);
        if (lastPetitionAt !== undefined && nowEpochMs - lastPetitionAt < this.criterion.deferred.minIntervalMs) {
            const armTrailing = !this.trailingByGroupKey.has(groupKey);
            this.trailingByGroupKey.set(groupKey, work);
            if (armTrailing) {
                this.criterion.deferred.schedule(
                    lastPetitionAt + this.criterion.deferred.minIntervalMs - nowEpochMs,
                    () => this.flushTrailing(groupKey)
                );
            }
            return;
        }
        this.lastPetitionAtByGroupKey.set(groupKey, nowEpochMs);
        await this.petition(work, read.snapshot.value);
    }
}
