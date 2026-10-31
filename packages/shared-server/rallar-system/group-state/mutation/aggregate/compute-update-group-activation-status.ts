import {
    computeGroupActivationCondition,
    GROUP_ACTIVATION_HYSTERESIS_WIDTH,
    resolveCoverageBasisLayoutIdentity,
    resolveGroupBusinessLiveness
} from '@shared/api/group-lifecycle/activation-status/compute-group-activation-condition.ts';
import { resolveNewerEvidenceWatermark } from '@shared/api/group-lifecycle/activation-status/compute-group-formation-reading.ts';
import { resolveGroupActivationCoverageWithHysteresis } from '@shared/api/group-lifecycle/activation-status/group-activation-coverage-hysteresis.ts';
import type { GroupActivationStatus } from '@shared/api/group-lifecycle/activation-status/group-activation-status.ts';
import { isSameGroupActivationSeries } from '@shared/api/group-lifecycle/activation-status/is-same-group-activation-series.ts';
import {
    isSameGroupLayoutIdentity,
    toGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import { isFormationAttemptBudgetExhausted } from '@shared/api/group-lifecycle/group-lifecycle-transitions.ts';
import type { Group } from '@shared/api/group-types.ts';

import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead
} from '../group-mutation-contracts.ts';
import {
    auditStamp,
    computeGroupMutationWriteResult,
    noOp,
    rejected,
    requireGroup
} from '../group-mutation-result.ts';
import { assertActive } from './group-aggregate-mutation-policy.ts';
import { resolveGroupAuthorityPolicy, toCorruptPolicyRejection } from './resolve-group-authority-policy.ts';

type UpdateActivationStatusCommand = Extract<GroupMutationCommand, { operation: 'updateGroupActivationStatus'; }>;

interface ResolveActivationStatusSeriesInput {
    readonly command: UpdateActivationStatusCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly group: Group;
}

type ResolvedActivationStatusSeries =
    | Readonly<{ status: 'rejected'; result: GroupMutationComputed; }>
    | Readonly<{ status: 'current'; basis: GroupLayoutIdentity; policy: GroupLifecyclePolicy; }>;

interface ComputeObservedActivationStatusInput {
    readonly command: UpdateActivationStatusCommand;
    readonly group: Group;
    readonly basis: GroupLayoutIdentity;
    readonly policy: GroupLifecyclePolicy;
    readonly facts: GroupMutationFacts;
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
    assertActive(stored.value, facts.attemptAtEpochMs);
    const group = stored.value;
    const series = resolveActivationStatusSeries({ command, read, facts, group });
    if (series.status === 'rejected') {
        return series.result;
    }
    if (isSupersededByStoredEvidence(command, group.activationStatus)) {
        return noOp(command, read, facts);
    }
    const next = computeObservedActivationStatus({
        command,
        group,
        basis: series.basis,
        policy: series.policy,
        facts
    });
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
        lifecyclePolicy: null,
        publicationGrantEffects: [],
        subscriptionEffects: [],
        subscriptionOutcome: null,
        presenceSummaryWork: 'enqueue'
    });
}

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
        !isSameGroupActivationSeries(stored, {
            formationEpoch: command.input.expectedFormationEpoch,
            coverageBasisLayoutIdentity: command.input.expectedLayout
        })
    ) {
        return false;
    }
    return resolveNewerEvidenceWatermark(observed, stored.evidenceWatermark) !== observed;
}

/** Nothing worth a group CAS, a durable event and a delta to every session. */
function isSamePublishedStatus(next: GroupActivationStatus, stored: GroupActivationStatus | null): boolean {
    return stored !== null &&
        stored.condition === next.condition &&
        isSameGroupActivationSeries(stored, next);
}

function resolveActivationStatusSeries(
    { command, read, facts, group }: ResolveActivationStatusSeriesInput
): ResolvedActivationStatusSeries {
    if (group.formationEpoch !== command.input.expectedFormationEpoch) {
        return {
            status: 'rejected',
            result: rejected({
                command,
                read,
                facts,
                rejectionCode: 'group-mutation-rejected',
                message:
                    `Activation status expected formation epoch ${command.input.expectedFormationEpoch}, found ${group.formationEpoch}`
            })
        };
    }
    const resolution = resolveGroupAuthorityPolicy(read);
    if (resolution.status === 'corrupt') {
        return {
            status: 'rejected',
            result: toCorruptPolicyRejection({ command, read, facts, reason: resolution.reason })
        };
    }
    const basis = resolveCoverageBasisLayoutIdentity({
        lifecycleState: group.lifecycleState,
        accepted: group.acceptedLayoutIdentity ?? undefined,
        plannedCandidate: read.plannedLayoutRow === null
            ? undefined
            : toGroupLayoutIdentity(read.plannedLayoutRow.snapshot)
    });
    if (basis === undefined || !isSameGroupLayoutIdentity(basis, command.input.expectedLayout)) {
        return {
            status: 'rejected',
            result: rejected({
                command,
                read,
                facts,
                rejectionCode: 'group-mutation-rejected',
                message: 'Activation status names a layout that no longer carries traffic'
            })
        };
    }
    return { status: 'current', basis, policy: resolution.policy };
}

function computeObservedActivationStatus(
    { command, group, basis, policy, facts }: ComputeObservedActivationStatusInput
): GroupActivationStatus {
    const business = resolveGroupBusinessLiveness(group, facts.attemptAtEpochMs);
    const attemptBudgetExhausted = isFormationAttemptBudgetExhausted({
        activation: policy.activation,
        formationAttemptCount: group.formationAttemptCount
    });
    const previousCondition = group.activationStatus !== null && isSameGroupActivationSeries(group.activationStatus, {
            formationEpoch: group.formationEpoch,
            coverageBasisLayoutIdentity: basis
        })
        ? group.activationStatus.condition
        : undefined;
    return {
        condition: computeGroupActivationCondition({
            business,
            lifecycleState: group.lifecycleState,
            attemptBudgetExhausted,
            coverage: resolveGroupActivationCoverageWithHysteresis({
                coverage: {
                    coverageRate: command.input.coverageRate,
                    successRate: policy.activation.successRate,
                    minimumViableRate: policy.activation.minimumViableRate,
                    dwellSatisfied: command.input.dwellSatisfied
                },
                previousCondition,
                hysteresisWidth: GROUP_ACTIVATION_HYSTERESIS_WIDTH
            })
        }),
        coverageRate: command.input.coverageRate,
        coverageBasisLayoutIdentity: basis,
        formationEpoch: group.formationEpoch,
        evidenceWatermark: command.input.evidenceWatermark,
        publishedAtEpochMs: facts.nowEpochMs
    };
}
