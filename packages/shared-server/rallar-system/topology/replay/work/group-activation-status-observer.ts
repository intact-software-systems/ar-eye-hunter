import {
    GROUP_ACTIVATION_EVIDENCE_EXPIRY_MS,
    resolveCoverageBasisLayoutIdentity,
    resolveGroupBusinessLiveness
} from '@shared/api/group-lifecycle/activation-status/compute-group-activation-condition.ts';
import {
    computeGroupFormationReading,
    type GroupFormationReading
} from '@shared/api/group-lifecycle/activation-status/compute-group-formation-reading.ts';
import { isSameGroupActivationSeries } from '@shared/api/group-lifecycle/activation-status/is-same-group-activation-series.ts';
import {
    resolveGroupActivationStatusAction,
    type GroupActivationStatusAction
} from '@shared/api/group-lifecycle/activation-status/resolve-group-activation-status-action.ts';
import {
    isSameGroupLayoutIdentity,
    toGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import { isFormationAttemptBudgetExhausted } from '@shared/api/group-lifecycle/group-lifecycle-transitions.ts';
import {
    toCanonicalGroupRef,
    type Group,
    type GroupRef
} from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import type { GroupActivationStatusClockWork } from '../../../group-state/activation-status-clock-outbox-entry.ts';
import type { GroupSystemCommandPort } from '../../../group-state/inbox/group-system-command-submission.ts';
import {
    toReadGroupLifecyclePolicy,
    type GroupLifecyclePolicyRead
} from '../../../group-state/persistence/group-lifecycle-policy-repository.ts';
import { toUpdateGroupActivationStatusCommand } from '../../../group-state/to-update-group-activation-status-command.ts';
import type { GroupTopologyPlanningAuthority } from '../../planning/group-topology-planning-authority.ts';

export interface GroupActivationStatusPort extends GroupSystemCommandPort {
    readLifecyclePolicy(groupRef: GroupRef): Promise<GroupLifecyclePolicyRead>;
    /**
     * Arms the durable dwell clock under the arming petition's trace; a second arm inside one dwell is a duplicate.
     */
    armStatusClock(work: GroupActivationStatusClockWork, traceId: string): Promise<void>;
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
 * no-ops an unchanged band within the same activation series. A new epoch
 * or basis must publish its own observed band.
 */
export interface PetitionGroupActivationStatusInput {
    readonly dependencies: GroupActivationStatusPetitionDependencies;
    readonly authority: GroupTopologyPlanningAuthority;
    readonly planned: RallarOverlayTopologySnapshot | null;
    /**
     * The clock's own confirmation. Null for the evidence leg, which may not
     * publish a dwell-held band; set when the durable clock came due, which is
     * the only path allowed to confirm one.
     */
    readonly dwell: Readonly<{ satisfied: true; dueAtEpochMs: number; }> | null;
    /** The petitioning message's trace; the status command and every clock arm carry it. */
    readonly traceId: string;
}

interface GroupActivationObservation {
    readonly groupRef: GroupRef;
    readonly formationEpoch: number;
    readonly coverageBasisLayoutIdentity: GroupLayoutIdentity;
    readonly reading: GroupFormationReading;
    readonly action: GroupActivationStatusAction;
    readonly hasPublishedStatus: boolean;
}

interface ComputeGroupActivationObservationInput {
    readonly authority: GroupTopologyPlanningAuthority;
    readonly planned: RallarOverlayTopologySnapshot;
    readonly basis: GroupLayoutIdentity;
    readonly policy: GroupLifecyclePolicy;
}

interface PublishGroupActivationPetitionInput {
    readonly port: GroupActivationStatusPort;
    readonly observation: GroupActivationObservation;
    readonly dwell: PetitionGroupActivationStatusInput['dwell'];
    readonly nowEpochMs: number;
    readonly traceId: string;
}

interface ArmEvidenceExpiryInput {
    readonly port: GroupActivationStatusPort;
    readonly groupRef: GroupRef;
    readonly formationEpoch: number;
    readonly coverageBasisLayoutIdentity: GroupLayoutIdentity;
    readonly nowEpochMs: number;
    readonly traceId: string;
}

export async function petitionGroupActivationStatus(
    { dependencies, authority, planned, dwell, traceId }: PetitionGroupActivationStatusInput
): Promise<void> {
    const port = dependencies.activationStatus;
    if (port === undefined || planned === null || planned.state !== 'active') {
        return;
    }
    const basis = resolveMeasurableGroupActivationBasis(authority.group.group, planned);
    if (basis === undefined) {
        return;
    }
    const policy = toReadGroupLifecyclePolicy(await port.readLifecyclePolicy(authority.group.group));
    if (policy === null) {
        return;
    }
    const observation = computeGroupActivationObservation({ authority, planned, basis, policy });
    await publishGroupActivationPetition({ port, observation, dwell, nowEpochMs: authority.nowEpochMs, traceId });
}

function resolveMeasurableGroupActivationBasis(
    group: Group,
    planned: RallarOverlayTopologySnapshot
): GroupLayoutIdentity | undefined {
    const plannedIdentity = toGroupLayoutIdentity(planned);
    const basis = resolveCoverageBasisLayoutIdentity({
        lifecycleState: group.lifecycleState,
        accepted: group.acceptedLayoutIdentity ?? undefined,
        plannedCandidate: plannedIdentity
    });
    // Measure only the layout that carries traffic. A newer planned candidate
    // must not report its coverage as the still-accepted layout's coverage.
    return basis !== undefined && isSameGroupLayoutIdentity(plannedIdentity, basis) ? basis : undefined;
}

function computeGroupActivationObservation(
    { authority, planned, basis, policy }: ComputeGroupActivationObservationInput
): GroupActivationObservation {
    const group = authority.group.group;
    const reading = computeGroupFormationReading({
        planned,
        rttMeasurements: authority.rttMeasurements,
        nowEpochMs: authority.nowEpochMs
    });
    const previousCondition = group.activationStatus !== null && isSameGroupActivationSeries(group.activationStatus, {
            formationEpoch: group.formationEpoch,
            coverageBasisLayoutIdentity: basis
        })
        ? group.activationStatus.condition
        : undefined;
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
        previousCondition,
        nowEpochMs: authority.nowEpochMs
    });
    return {
        groupRef: toCanonicalGroupRef(group),
        formationEpoch: group.formationEpoch,
        coverageBasisLayoutIdentity: basis,
        reading,
        action,
        hasPublishedStatus: group.activationStatus !== null
    };
}

async function publishGroupActivationPetition(
    { port, observation, dwell, nowEpochMs, traceId }: PublishGroupActivationPetitionInput
): Promise<void> {
    const { groupRef, formationEpoch, coverageBasisLayoutIdentity, reading, action } = observation;
    if (action.kind === 'arm-dwell' && dwell === null) {
        await port.armStatusClock({
            kind: 'dwell',
            groupRef,
            formationEpoch,
            coverageBasisLayoutIdentity,
            candidateCondition: action.condition,
            dueAtEpochMs: action.dueAtEpochMs
        }, traceId);
        return;
    }
    if (action.kind !== 'none') {
        await port.submitCommand({
            command: toUpdateGroupActivationStatusCommand({
                groupRef,
                formationEpoch,
                coverageBasisLayoutIdentity,
                coverageRate: reading.readiness.observedRate,
                evidenceWatermark: action.kind === 'arm-dwell' ? null : reading.evidenceWatermark,
                dwell: action.kind === 'arm-dwell' ? dwell : null
            }),
            atEpochMs: nowEpochMs,
            traceId
        });
    }
    // A confirmed dwell does not arm expiry. Otherwise only evidence can decay;
    // an absent status or a zero-evidence floor must leave no recurring clock.
    const expiresEvidence = action.kind === 'write' || action.kind === 'none' && observation.hasPublishedStatus;
    if (expiresEvidence && reading.evidenceWatermark !== null) {
        await armEvidenceExpiry({ port, groupRef, formationEpoch, coverageBasisLayoutIdentity, nowEpochMs, traceId });
    }
}

/** Consumed when it fires and re-armed only while the next reading still counts evidence. */
async function armEvidenceExpiry(
    { port, groupRef, formationEpoch, coverageBasisLayoutIdentity, nowEpochMs, traceId }: ArmEvidenceExpiryInput
): Promise<void> {
    await port.armStatusClock({
        kind: 'evidence-expiry',
        groupRef,
        formationEpoch,
        coverageBasisLayoutIdentity,
        candidateCondition: null,
        dueAtEpochMs: nowEpochMs + GROUP_ACTIVATION_EVIDENCE_EXPIRY_MS
    }, traceId);
}
