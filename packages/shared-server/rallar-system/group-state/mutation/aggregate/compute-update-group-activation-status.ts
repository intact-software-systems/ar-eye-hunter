import {
    computeGroupActivationCondition,
    GROUP_ACTIVATION_HYSTERESIS_WIDTH,
    resolveCoverageBasisLayoutIdentity,
    resolveGroupActivationRemediation,
    resolveGroupBusinessLiveness
} from '@shared/api/group-lifecycle/compute-group-activation-condition.ts';
import { resolveNewerEvidenceWatermark } from '@shared/api/group-lifecycle/compute-group-formation-reading.ts';
import { resolveGroupActivationCoverageWithHysteresis } from '@shared/api/group-lifecycle/group-activation-coverage-hysteresis.ts';
import type { GroupActivationStatus } from '@shared/api/group-lifecycle/group-activation-status.ts';
import { isSameGroupLayoutIdentity, toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { isFormationAttemptBudgetExhausted } from '@shared/api/group-lifecycle/group-lifecycle-transitions.ts';
import type { Group } from '@shared/api/group-types.ts';

import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead
} from '../group-mutation-contracts.ts';
import { auditStamp, computeGroupMutationWriteResult, noOp, rejected, requireGroup } from '../group-mutation-result.ts';
import { assertActive } from './group-aggregate-mutation-policy.ts';
import { resolveGroupAuthorityPolicy, toCorruptPolicyRejection } from './resolve-group-authority-policy.ts';

type UpdateActivationStatusCommand = Extract<GroupMutationCommand, { operation: 'updateGroupActivationStatus'; }>;

/**
 * Is this reading newer than the status already on the row, within one causal
 * series? Product decision 33: a write must strictly advance its evidence
 * watermark, and an equal-or-older one is a typed drop that writes nothing.
 *
 * The rule is scoped to the series `(formationEpoch, coverageBasisLayoutIdentity)`,
 * because a changed basis starts a distinct series whose watermarks are not
 * comparable. A clock's write carries no watermark at all and is never
 * dropped here: a decay that is the *absence* of evidence can never advance
 * one, which is why the durable clocks exist.
 */
function isSupersededByStoredEvidence(
    command: UpdateActivationStatusCommand,
    stored: GroupActivationStatus | null
): boolean {
    const observed = command.input.evidenceWatermark;
    if (observed === null || stored === null || stored.evidenceWatermark === null) {
        return false;
    }
    if (
        stored.formationEpoch !== command.input.expectedFormationEpoch ||
        !isSameGroupLayoutIdentity(stored.coverageBasisLayoutIdentity, command.input.expectedLayout)
    ) {
        return false;
    }
    return resolveNewerEvidenceWatermark(observed, stored.evidenceWatermark) !== observed;
}

/** Nothing worth a group CAS, a durable event and a delta to every session. */
function isSamePublishedStatus(next: GroupActivationStatus, stored: GroupActivationStatus | null): boolean {
    return stored !== null &&
        stored.condition === next.condition &&
        stored.remediation === next.remediation &&
        isSameGroupLayoutIdentity(stored.coverageBasisLayoutIdentity, next.coverageBasisLayoutIdentity) &&
        stored.formationEpoch === next.formationEpoch;
}

/**
 * The observed-status write (product decision 3): derived, non-authoritative
 * state that no policy or gate reads. It is route-less — the topology work
 * cycle's petition and the dwell clock are its only producers — and it
 * touches nothing but `activationStatus`: no stage, epoch, electorate or
 * layout.
 *
 * Three guards, in order. A stale epoch or a basis that no longer carries
 * traffic is a typed rejection, because the observation describes a layout
 * the group has moved past. An equal-or-older evidence watermark inside one
 * series is a typed drop. And a status that would publish what is already on
 * the row is a no-op, so a steady group costs nothing.
 */
export function computeUpdateGroupActivationStatus(
    command: UpdateActivationStatusCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    assertActive(stored.value, facts.nowEpochMs);
    const group = stored.value;
    if (group.formationEpoch !== command.input.expectedFormationEpoch) {
        return rejected({
            command,
            read,
            facts,
            rejectionCode: 'group-mutation-rejected',
            message:
                `Activation status expected formation epoch ${command.input.expectedFormationEpoch}, found ${group.formationEpoch}`
        });
    }
    const resolution = resolveGroupAuthorityPolicy(read);
    if (resolution.status === 'corrupt') {
        return toCorruptPolicyRejection({ command, read, facts, reason: resolution.reason });
    }
    const basis = resolveCoverageBasisLayoutIdentity({
        lifecycleState: group.lifecycleState,
        accepted: group.acceptedLayoutIdentity ?? undefined,
        plannedCandidate: read.plannedLayoutRow === null
            ? undefined
            : toGroupLayoutIdentity(read.plannedLayoutRow.snapshot)
    });
    if (basis === undefined || !isSameGroupLayoutIdentity(basis, command.input.expectedLayout)) {
        return rejected({
            command,
            read,
            facts,
            rejectionCode: 'group-mutation-rejected',
            message: 'Activation status names a layout that no longer carries traffic'
        });
    }
    if (isSupersededByStoredEvidence(command, group.activationStatus)) {
        return noOp(command, read, facts);
    }
    const business = resolveGroupBusinessLiveness(group, facts.nowEpochMs);
    const attemptBudgetExhausted = isFormationAttemptBudgetExhausted({
        activation: resolution.policy.activation,
        formationAttemptCount: group.formationAttemptCount
    });
    const next: GroupActivationStatus = {
        condition: computeGroupActivationCondition({
            business,
            lifecycleState: group.lifecycleState,
            attemptBudgetExhausted,
            coverage: resolveGroupActivationCoverageWithHysteresis({
                coverage: {
                    coverageRate: command.input.coverageRate,
                    successRate: resolution.policy.activation.successRate,
                    minimumViableRate: resolution.policy.activation.minimumViableRate,
                    dwellSatisfied: command.input.dwellSatisfied
                },
                previousCondition: group.activationStatus?.condition,
                hysteresisWidth: GROUP_ACTIVATION_HYSTERESIS_WIDTH
            })
        }),
        remediation: resolveGroupActivationRemediation({
            business,
            lifecycleState: group.lifecycleState,
            attemptBudgetExhausted,
            replanQueued: command.input.replanQueued,
            layoutStale: command.input.layoutStale,
            replanning: resolution.policy.topology.replanning
        }),
        coverageRate: command.input.coverageRate,
        coverageBasisLayoutIdentity: basis,
        formationEpoch: group.formationEpoch,
        evidenceWatermark: command.input.evidenceWatermark,
        confirmedAtEpochMs: facts.nowEpochMs
    };
    if (isSamePublishedStatus(next, group.activationStatus)) {
        return noOp(command, read, facts);
    }
    const written: Group = {
        ...group,
        activationStatus: next,
        snapshotVersion: group.snapshotVersion + 1,
        updated: auditStamp(command, facts, undefined)
    };
    return computeGroupMutationWriteResult({
        command,
        read,
        facts,
        guard: {
            kind: 'group',
            operation: 'update',
            value: written,
            expectedRevision: stored.entry.revision
        },
        members: [],
        initialPresenceSummary: null,
        presenceAdmission: null,
        eventType: 'group-activation-status-changed',
        presenceSummaryWork: 'enqueue'
    });
}
