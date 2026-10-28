import { toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';
import {
    evaluateGroupStageTrigger,
    resolveGroupStageTrigger
} from '@shared/api/group-lifecycle/evaluate-group-stage-trigger.ts';
import {
    consumesFormationDeadlineAt,
    holdsPlannedCandidateAt
} from '@shared/api/group-lifecycle/resolve-formation-stage-entry.ts';
import { fromCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import {
    toCanonicalGroupRef,
    type Group,
    type GroupRef
} from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import { toFormationPresencePlanCommand } from '../../../group-state/group-formation-mutation-command.ts';
import type { GroupSystemCommandPort } from '../../../group-state/inbox/group-system-command-submission.ts';
import {
    toReadGroupLifecyclePolicy,
    type GroupLifecyclePolicyRead
} from '../../../group-state/persistence/group-lifecycle-policy-repository.ts';
import type { RtcTopologyMutationRead } from '../../mutation/rtc-topology-mutations.ts';
import type { RtcTopologyRttRefreshWork } from '../../mutation/rtc-topology-outbox-entry.ts';
import type { RtcTopologyExecutionRepository } from '../../persistence/rtc-topology-execution-repository.ts';
import type { GroupTopologyPlanningAuthority } from '../../planning/group-topology-planning-authority.ts';
import type { GroupTopologyPlanningService } from '../../planning/group-topology-planning-service.ts';
import { computeFormationCriterionCommand } from './compute-formation-criterion-command.ts';
import type { CommittedCriterionPetition } from './compute-rtc-topology-work-write.ts';
import {
    petitionAwaitingGroupConnectTriggers,
    type GroupFormationAutomationPort
} from './create-group-connect-trigger-work-handler.ts';

export interface FormationCriterionPort extends GroupSystemCommandPort {
    readonly readLifecyclePolicy: (ref: GroupRef) => Promise<GroupLifecyclePolicyRead>;
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
    /** The trace names the requesting message; a damped request petitions later under it. */
    request(work: RtcTopologyRttRefreshWork, read: RtcTopologyMutationRead, traceId: string): Promise<void>;
}

/**
 * The evidence leg of the activation criterion: observation petitions intent
 * and the petitioned command re-authorizes through AppInbox with fresh state,
 * so a stale petition is a replay or a typed rejection, never a wrong
 * transition.
 */
export async function petitionFormationCriterion(
    dependencies: DeferredCriterionPetitionDependencies,
    { authority, planned }: CommittedCriterionPetition,
    traceId: string
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
    await dependencies.formationCriterion.submitCommand({ command, atEpochMs: authority.nowEpochMs, traceId });
}

export interface StageTriggerPetitionDependencies {
    readonly formationCriterion?: Pick<FormationCriterionPort, 'readLifecyclePolicy'>;
    readonly formationAutomation?: GroupFormationAutomationPort;
}

/**
 * The presence trigger's evidence leg (product decision 8). Every presence
 * change of a group already reaches this cycle — the topology input
 * fingerprint hashes the live session set — so the threshold half of
 * `presence` is answered here, where the policy read and the automation
 * submit already are, while its fallback half stays with the durable timer
 * the stage entry armed. The other kinds have no evidence to observe: they
 * fire from that timer or from the publication that petitions the latch.
 *
 * The count is the one the work's own revision carries, so a member who
 * leaves between the presence write and this cycle can still be counted;
 * the dial that follows is evidence for the activation criterion like any
 * other, and a group that cannot reach its floor fails its attempt. What
 * the petition must not do is carry that evidence across a series, so a
 * met threshold names the formation epoch it was observed at.
 */
export async function petitionGroupStageTrigger(
    dependencies: StageTriggerPetitionDependencies,
    authority: GroupTopologyPlanningAuthority,
    traceId: string
): Promise<void> {
    const automation = dependencies.formationAutomation;
    if (!dependencies.formationCriterion || automation === undefined) {
        return;
    }
    const group = authority.group.group;
    if (!isFreshFormingSeries(group) && !holdsPlannedCandidateAt(group.lifecycleState)) {
        return;
    }
    const policyRead = await dependencies.formationCriterion.readLifecyclePolicy(group);
    const policy = toReadGroupLifecyclePolicy(policyRead);
    if (policy === null || policy.formation !== 'phased') {
        return;
    }
    const trigger = resolveGroupStageTrigger(policy, group.lifecycleState);
    if (trigger?.kind !== 'presence') {
        return;
    }
    const decision = evaluateGroupStageTrigger({
        trigger,
        // The elapsed half belongs to the timer leg this stage entry armed.
        stageEnteredAtEpochMs: null,
        nowEpochMs: authority.nowEpochMs,
        livePresenceMemberCount: authority.group.onlineMemberCount
    });
    if (decision !== 'fire') {
        return;
    }
    try {
        await submitSatisfiedStageTrigger(automation, authority, traceId);
    }
    catch (error) {
        // The work item is already committed and finished: a failed petition
        // must not lose it. The trigger's own fallback timer is the backstop,
        // and the next presence change petitions again.
        console.warn('Group stage trigger petition failed', error);
    }
}

/**
 * Only a series that has spent no attempt is planned by its trigger: a
 * below-floor return to `forming` belongs to the retry leg, which paces the
 * next attempt under backoff and stops at the attempt budget.
 */
function isFreshFormingSeries(group: Group): boolean {
    return group.lifecycleState === 'forming' && group.formationAttemptCount === 0;
}

async function submitSatisfiedStageTrigger(
    automation: GroupFormationAutomationPort,
    authority: GroupTopologyPlanningAuthority,
    traceId: string
): Promise<void> {
    const group = authority.group.group;
    const groupRef = toCanonicalGroupRef(group);
    if (holdsPlannedCandidateAt(group.lifecycleState)) {
        await petitionAwaitingGroupConnectTriggers(automation, groupRef, {
            settle: { kind: 'satisfied', observedFormationEpoch: group.formationEpoch },
            traceId
        });
        return;
    }
    await automation.submitCommand({
        command: toFormationPresencePlanCommand({
            groupRef,
            formationEpoch: group.formationEpoch,
            presenceVersion: group.presenceVersion
        }),
        atEpochMs: authority.nowEpochMs,
        traceId
    });
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

/** A deferred petition request: the RTT work and the trace of the message that asked for it. */
interface DeferredCriterionRequest {
    readonly work: RtcTopologyRttRefreshWork;
    readonly traceId: string;
}

class DeferredFormationCriterionPetitioner implements DeferredCriterionPetitioner {
    private readonly lastPetitionAtByGroupKey = new Map<string, number>();
    private readonly trailingByGroupKey = new Map<string, DeferredCriterionRequest>();
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
        { work, traceId }: DeferredCriterionRequest,
        planned: RallarOverlayTopologySnapshot
    ): Promise<void> {
        const authority = await this.dependencies.topologyPlanning.readTopologyPlanningAuthority({
            groupRef: work.groupSnapshot.group,
            requestOptions: fromCanonicalGroupTopologyConfigPatch(work.requestOptions),
            knownGroup: work.groupSnapshot
        });
        await petitionFormationCriterion(this.dependencies, { authority, planned }, traceId);
    }

    private async flushTrailing(groupKey: string): Promise<void> {
        const trailing = this.trailingByGroupKey.get(groupKey);
        this.trailingByGroupKey.delete(groupKey);
        if (!trailing) {
            return;
        }
        this.lastPetitionAtByGroupKey.set(groupKey, this.criterion.deferred.nowEpochMs());
        try {
            const read = await this.dependencies.executionRepository.readTopologyMutation(
                trailing.work.groupSnapshot.group,
                null
            );
            if (read.snapshot !== null && read.snapshot.value.state === 'active') {
                await this.petition(trailing, read.snapshot.value);
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

    async request(work: RtcTopologyRttRefreshWork, read: RtcTopologyMutationRead, traceId: string): Promise<void> {
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
            this.trailingByGroupKey.set(groupKey, { work, traceId });
            if (armTrailing) {
                this.criterion.deferred.schedule(
                    lastPetitionAt + this.criterion.deferred.minIntervalMs - nowEpochMs,
                    () => this.flushTrailing(groupKey)
                );
            }
            return;
        }
        this.lastPetitionAtByGroupKey.set(groupKey, nowEpochMs);
        await this.petition({ work, traceId }, read.snapshot.value);
    }
}
