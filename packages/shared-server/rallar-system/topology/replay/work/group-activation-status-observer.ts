import {
    GROUP_ACTIVATION_EVIDENCE_EXPIRY_MS,
    resolveGroupBusinessLiveness
} from '@shared/api/group-lifecycle/compute-group-activation-condition.ts';
import { resolveCoverageBasisLayoutIdentity } from '@shared/api/group-lifecycle/compute-group-activation-condition.ts';
import { computeGroupFormationReading } from '@shared/api/group-lifecycle/compute-group-formation-reading.ts';
import {
    isSameGroupLayoutIdentity,
    toGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { isFormationAttemptBudgetExhausted } from '@shared/api/group-lifecycle/group-lifecycle-transitions.ts';
import { resolveGroupActivationStatusAction } from '@shared/api/group-lifecycle/resolve-group-activation-status-action.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { GroupActivationStatusClockWork } from '../../../group-state/activation-status-clock-outbox-entry.ts';
import {
    toReadGroupLifecyclePolicy,
    type GroupLifecyclePolicyRead
} from '../../../group-state/persistence/group-lifecycle-policy-repository.ts';

import type { GroupMutationCommand } from '../../../group-state/mutation/group-mutation-contracts.ts';
import { toUpdateGroupActivationStatusCommand } from '../../../group-state/to-update-group-activation-status-command.ts';
import type { GroupTopologyPlanningAuthority } from '../../planning/group-topology-planning-authority.ts';

export interface GroupActivationStatusPort {
    submitCommand(command: GroupMutationCommand, atEpochMs: number): Promise<void>;
    readLifecyclePolicy(groupRef: GroupRef): Promise<GroupLifecyclePolicyRead>;
    /** Arms the durable dwell clock; a second arm inside one dwell is a duplicate. */
    armStatusClock(work: GroupActivationStatusClockWork): Promise<void>;
}

export interface GroupActivationStatusPetitionDependencies {
    readonly activationStatus?: GroupActivationStatusPort;
}

/**
 * The evidence leg of the observed status (product decision 3). It rides the
 * topology work cycle rather than widening the criterion's establishment
 * guard: `consumesFormationDeadlineAt` is the only thing keeping an `active`
 * group at zero criterion evaluations per minute, and widening it is what
 * turns that zero into one evaluation per accepted RTT mutation. Riding the
 * cycle instead inherits the dampers already between evidence and this
 * point -- the RTT refinement gate and the fingerprint skip -- so the status
 * costs no new evaluation rate of its own.
 *
 * Petitioning is not writing. The command re-authorizes through AppInbox
 * against fresh state, and its compute drops an equal-or-older watermark and
 * no-ops an unchanged band, so a steady group pays an enqueue and nothing
 * durable.
 */
export async function petitionGroupActivationStatus(
    dependencies: GroupActivationStatusPetitionDependencies,
    authority: GroupTopologyPlanningAuthority,
    planned: RallarOverlayTopologySnapshot | null,
    /**
     * The clock's own confirmation. Null for the evidence leg, which may not
     * publish a dwell-held band; set when the durable clock came due, which is
     * the only path allowed to confirm one.
     */
    dwell: Readonly<{ satisfied: true; dueAtEpochMs: number; }> | null = null
): Promise<void> {
    if (!dependencies.activationStatus) {
        return;
    }
    const group = authority.group.group;
    const basis = resolveCoverageBasisLayoutIdentity({
        lifecycleState: group.lifecycleState,
        accepted: group.acceptedLayoutIdentity ?? undefined,
        plannedCandidate: planned === null || planned.state !== 'active'
            ? undefined
            : toGroupLayoutIdentity(planned)
    });
    if (basis === undefined) {
        // No layout carries traffic or is being dialed, so there is no
        // coverage to report and no causal series to report it in.
        return;
    }
    if (
        planned === null || planned.state !== 'active' ||
        !isSameGroupLayoutIdentity(toGroupLayoutIdentity(planned), basis)
    ) {
        // Measure the layout the basis names or measure nothing. The snapshot
        // in hand is the one this work cycle committed, which is not always
        // the accepted layout the basis resolves to -- and reporting a
        // planned candidate's coverage as the accepted layout's is the exact
        // confusion slice 12a's review caught on the read surface.
        return;
    }
    const policy = toReadGroupLifecyclePolicy(
        await dependencies.activationStatus.readLifecyclePolicy(group)
    );
    if (policy === null) {
        // A corrupt policy carries no thresholds, so there is no band to
        // report and nothing honest to publish.
        return;
    }
    const reading = computeGroupFormationReading({
        planned,
        rttMeasurements: authority.rttMeasurements,
        nowEpochMs: authority.nowEpochMs
    });
    const groupRef = {
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        groupId: group.groupId
    };
    const action = resolveGroupActivationStatusAction({
        business: resolveGroupBusinessLiveness(group, authority.nowEpochMs),
        lifecycleState: group.lifecycleState,
        attemptBudgetExhausted: isFormationAttemptBudgetExhausted({
            activation: policy.activation,
            formationAttemptCount: group.formationAttemptCount
        }),
        coverage: {
            coverageRate: reading.readiness.observedRate,
            successRate: policy.activation.successRate,
            minimumViableRate: policy.activation.minimumViableRate
        },
        previousCondition: group.activationStatus?.condition,
        nowEpochMs: authority.nowEpochMs
    });
    if (action.kind === 'none') {
        // Steady is still worth a heartbeat: coverage decays by evidence
        // ageing out, which nothing else observes, so the group must ask
        // itself again. enqueueIfAbsent makes this one row per group.
        await armEvidenceExpiry(dependencies, groupRef, group.formationEpoch, basis, authority.nowEpochMs);
        return;
    }
    if (action.kind === 'arm-dwell' && dwell !== null) {
        // The clock came due and the band still holds, so this is the write
        // the dwell was waiting for.
        await dependencies.activationStatus.submitCommand(
            toUpdateGroupActivationStatusCommand({
                groupRef,
                formationEpoch: group.formationEpoch,
                coverageBasisLayoutIdentity: basis,
                coverageRate: reading.readiness.observedRate,
                evidenceWatermark: null,
                dwell
            }),
            authority.nowEpochMs
        );
        return;
    }
    if (action.kind === 'arm-dwell') {
        await dependencies.activationStatus.armStatusClock({
            kind: 'dwell',
            groupRef,
            formationEpoch: group.formationEpoch,
            coverageBasisLayoutIdentity: basis,
            candidateCondition: action.condition,
            dueAtEpochMs: action.dueAtEpochMs
        });
        return;
    }
    await dependencies.activationStatus.submitCommand(
        toUpdateGroupActivationStatusCommand({
            groupRef,
            formationEpoch: group.formationEpoch,
            coverageBasisLayoutIdentity: basis,
            coverageRate: reading.readiness.observedRate,
            evidenceWatermark: reading.evidenceWatermark,
            dwell: null
        }),
        authority.nowEpochMs
    );
    await armEvidenceExpiry(dependencies, groupRef, group.formationEpoch, basis, authority.nowEpochMs);
}

/** The self-rescheduling heartbeat: consumed when it fires, re-armed by the reading it causes. */
async function armEvidenceExpiry(
    dependencies: GroupActivationStatusPetitionDependencies,
    groupRef: GroupRef,
    formationEpoch: number,
    coverageBasisLayoutIdentity: GroupLayoutIdentity,
    nowEpochMs: number
): Promise<void> {
    await dependencies.activationStatus?.armStatusClock({
        kind: 'evidence-expiry',
        groupRef,
        formationEpoch,
        coverageBasisLayoutIdentity,
        candidateCondition: null,
        dueAtEpochMs: nowEpochMs + GROUP_ACTIVATION_EVIDENCE_EXPIRY_MS
    });
}
