import { toRtcTopologyPublicationId } from '@shared-server/rallar-system/topology/persistence/rtc-topology-identifiers.ts';
import type { StoredTopologyReshapeGate } from '@shared-server/rallar-system/topology/persistence/rtc-topology-reshape-gate-store.ts';
import type { GroupTopologyPlanningAuthority } from '@shared-server/rallar-system/topology/planning/group-topology-planning-authority.ts';
import { computeRtcTopologyExecutionCommandDigest } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository-contracts.ts';
import type { RtcTopologyPublication } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication.ts';
import { toCanonicalGroupRef, type GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { RtcTopologyPlanRecord } from '@shared/api/topology-plan/rtc-topology-plan-record.ts';
import type { TopologyReshapePermission } from '@shared/api/topology-plan/topology-reshape-gate.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { ResourceInboxReservationFinish } from '../../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import { validateComputedEitherProjection } from '../../../computed-data-validation.ts';
import { GroupTopologyValidationError } from '../../group-topology-errors.ts';
import {
    computeTopologyMutation,
    validateTopologyMutation,
    type RtcTopologyMutationComputed,
    type RtcTopologyMutationInput,
    type RtcTopologyMutationRead
} from '../../mutation/rtc-topology-mutations.ts';
import {
    computeGroupTopologyFromAuthority,
    validateComputedTopologySnapshot
} from '../../planning/compute-group-topology-from-authority.ts';
import type { ReconcileGroupTopologyResult } from '../../planning/group-topology-planning-contracts.ts';
import {
    type RtcOverlayTopologyMessageFacts
} from '../../planning/materialize-rtc-overlay-topology-messages.ts';
import { computeRtcTopologyPlanRecord } from '../../planning/plan-record/compute-rtc-topology-plan-record.ts';
import type { RtcTopologyPlanDerivation } from '../../planning/plan-record/rtc-topology-plan-derivation.ts';
import {
    computeTopologyReshapeGate,
    UNCHANGED_TOPOLOGY_RESHAPE_GATE,
    type ComputedTopologyReshapeGate,
    type TopologyReshapeGatePlanOutcome
} from '../../planning/reshape-gate/compute-topology-reshape-gate.ts';
import { resolveTopologyReshapePermission } from '../../planning/reshape-gate/resolve-topology-reshape-permission.ts';
import {
    resolveRttReplanPromotion,
    type HeldRttReplan,
    type PromotedRttReplan
} from '../../planning/resolve-rtt-replan-promotion.ts';
import {
    computeRtcTopologyWorkWrite,
    type AcceptedRtcTopologyWork,
    type AcceptedRtcTopologyWorkWrite,
    type ComputeRtcTopologyWorkWriteInput
} from './compute-rtc-topology-work-write.ts';
import { isChangeGatedGroupRevisionWork, toTopologyWorkOrigin } from './rtc-topology-coalesced-group-revision-work.ts';
import { computeAuthorityTopologyInputFingerprint } from './rtc-topology-input-fingerprint.ts';
import type { PersistedRtcTopologyWork, RtcTopologyWorkEnvelope } from './rtc-topology-work-codec.ts';
import type { TopologyPromotionRead } from './topology-promotion-request.ts';

export interface RtcTopologyWorkFacts {
    readonly workEnvelope: RtcTopologyWorkEnvelope<PersistedRtcTopologyWork>;
    readonly workId: string;
    readonly attemptCount: number;
    /**
     * The expiry of every row this attempt derives: the later of its own row's expiry and the finished-retention
     * window from the attempt, so a row derived from a long-lived row near its expiry still lives its window.
     */
    readonly derivedExpireAtEpochMs: number;
    /** From the retained work row's envelope, never re-minted, so retries and recomputes reproduce the same rows. */
    readonly traceId: string;
}

export interface RtcTopologyWorkRead {
    readonly mutation: RtcTopologyMutationRead;
    readonly authority: GroupTopologyPlanningAuthority;
    readonly promotion: TopologyPromotionRead | null;
    readonly storedInputFingerprint: string | null;
    readonly reshapeGate: StoredTopologyReshapeGate | null;
}

export interface ComputeRtcTopologyWorkInput {
    readonly facts: RtcTopologyWorkFacts;
    readonly read: RtcTopologyWorkRead;
    readonly publicationExpireAtTimestamp: number | null;
    readonly entry: ResourceEntry;
    readonly reservationFinish: ResourceInboxReservationFinish;
    readonly formationAutomationEnabled: boolean;
    readonly serviceId: string | undefined;
    readonly publisherStreamId: string | undefined;
}

interface ComputedRtcTopologyWork {
    readonly accepted: AcceptedRtcTopologyWork;
    readonly write: AcceptedRtcTopologyWorkWrite;
}

type RtcTopologyWorkComputation = Either<
    Extract<RtcTopologyMutationComputed, { outcome: 'retry'; }>,
    ComputedRtcTopologyWork
>;

export interface RtcTopologyWorkValidationIssue {
    readonly path: string;
    readonly message: string;
    readonly cause: Error;
}

interface ComputeAcceptedTopologyMutationInput {
    readonly facts: RtcTopologyWorkFacts;
    readonly read: RtcTopologyWorkRead;
    readonly planned: PlannedTopology;
    readonly reshape: TopologyReshapePermission;
    readonly inputFingerprint: string;
    readonly publicationExpireAtTimestamp: number | null;
    readonly rttReplanPromotion: PromotedRttReplan | null;
}

interface ComputeUnchangedTopologyWorkInput {
    readonly work: ComputeRtcTopologyWorkInput;
    readonly planned: PlannedTopology;
    readonly reshape: TopologyReshapePermission;
    readonly inputFingerprint: string;
}

type PlannedTopology = Extract<ReconcileGroupTopologyResult, { action: 'planned'; }>;

type FrozenRtcTopologyWork = Extract<AcceptedRtcTopologyWork, { decision: 'skipped-frozen'; }>;

type UnchangedRtcTopologyWork = Extract<AcceptedRtcTopologyWork, { decision: 'skipped-unchanged'; }>;

type HeldRtcTopologyWork = Extract<AcceptedRtcTopologyWork, { decision: 'held-young-layout'; }>;

interface ToTopologyPublicationInput {
    readonly group: GroupSnapshot;
    readonly snapshot: RallarOverlayTopologySnapshot;
    readonly plan: RtcTopologyPlanRecord | null;
    readonly facts: RtcOverlayTopologyMessageFacts;
}

export function computeRtcTopologyWork(
    input: ComputeRtcTopologyWorkInput
): RtcTopologyWorkComputation {
    const accepted = computeAcceptedRtcTopologyWork(input);
    if (accepted.right === undefined) {
        return Either.ofLeft(accepted.left!);
    }
    return Either.ofRight({
        accepted: accepted.right,
        write: computeRtcTopologyWorkWrite(toRtcTopologyWorkWriteInput(input, accepted.right))
    });
}

export function validateRtcTopologyWork(
    input: ComputeRtcTopologyWorkInput,
    computed: RtcTopologyWorkComputation
): readonly RtcTopologyWorkValidationIssue[] {
    const expected = computeRtcTopologyWork(input);
    return [
        ...validateComputedEitherProjection(expected, computed, 'computed'),
        ...(expected.right === undefined ? [] : validateAcceptedTopologyDecision(expected.right.accepted))
    ];
}

function validateAcceptedTopologyDecision(
    accepted: AcceptedRtcTopologyWork
): readonly RtcTopologyWorkValidationIssue[] {
    if (accepted.decision === 'skipped-rtt-refinement') {
        return [];
    }
    if (accepted.decision === 'accepted') {
        if (accepted.mutationInput.candidate === null) {
            const message = 'Accepted RTC topology work requires a computed topology';
            return [{ path: 'computed.accepted.mutationInput.candidate', message, cause: new TypeError(message) }];
        }
        return [
            ...validateTopologyMutation({
                ...accepted.mutationInput,
                computed: accepted.computed
            }),
            ...validateTopologySnapshot(
                accepted.mutationInput.candidate,
                'computed.accepted.mutationInput.candidate'
            )
        ];
    }
    if (accepted.criterionPetition === null) {
        const message = 'Skipped RTC topology work requires its selected topology';
        return [{ path: 'computed.accepted.criterionPetition', message, cause: new TypeError(message) }];
    }
    return validateTopologySnapshot(
        accepted.criterionPetition.planned,
        'computed.accepted.criterionPetition.planned'
    );
}

function validateTopologySnapshot(
    snapshot: RallarOverlayTopologySnapshot,
    path: string
): readonly RtcTopologyWorkValidationIssue[] {
    const topologyIssues = validateComputedTopologySnapshot(snapshot);
    const cause = new GroupTopologyValidationError(topologyIssues);
    return topologyIssues.map((issue) => ({
        path: `${path}.${(issue.path ?? []).join('.')}`,
        message: issue.message,
        cause
    }));
}

function toRtcTopologyWorkWriteInput(
    input: ComputeRtcTopologyWorkInput,
    accepted: AcceptedRtcTopologyWork
): ComputeRtcTopologyWorkWriteInput {
    return {
        accepted,
        entry: input.entry,
        sourceWorkId: input.facts.workId,
        derivedExpireAtEpochMs: input.facts.derivedExpireAtEpochMs,
        reservationFinish: input.reservationFinish,
        formationAutomationEnabled: input.formationAutomationEnabled,
        serviceId: input.serviceId,
        publisherStreamId: input.publisherStreamId,
        traceId: input.facts.traceId,
        storedReshapeGateRevision: input.read.reshapeGate?.revision ?? null
    };
}

function computeAcceptedRtcTopologyWork(
    input: ComputeRtcTopologyWorkInput
): Either<Extract<RtcTopologyMutationComputed, { outcome: 'retry'; }>, AcceptedRtcTopologyWork> {
    const inputFingerprint = computeAuthorityTopologyInputFingerprint(input.read.authority);
    const fingerprintSkip = computeFingerprintSkip(input, inputFingerprint);
    if (fingerprintSkip !== null) {
        return Either.ofRight(fingerprintSkip);
    }
    const reshape = resolveWorkReshapePermission(input);
    const computedTopology = computeWorkTopology(input, reshape);
    if (computedTopology.action === 'frozen') {
        return Either.ofRight(toFrozenTopologyWork(input, computedTopology.current));
    }
    const unchanged = computeUnchangedTopologyWork({
        work: input,
        planned: computedTopology,
        reshape,
        inputFingerprint
    });
    if (unchanged !== null) {
        return Either.ofRight(unchanged);
    }
    const rttReplan = computeRttReplan(input, inputFingerprint);
    if (rttReplan?.decision === 'held-young-layout') {
        return Either.ofRight(rttReplan);
    }
    return computeAcceptedTopologyMutation({
        facts: input.facts,
        read: input.read,
        planned: computedTopology,
        reshape,
        inputFingerprint,
        publicationExpireAtTimestamp: input.publicationExpireAtTimestamp,
        rttReplanPromotion: rttReplan
    });
}

function resolveWorkReshapePermission(input: ComputeRtcTopologyWorkInput): TopologyReshapePermission {
    const { authority, reshapeGate } = input.read;
    return resolveTopologyReshapePermission({
        state: reshapeGate?.state ?? null,
        bounds: authority.reshapeBounds,
        workOrigin: toTopologyWorkOrigin(input.facts.workEnvelope.data),
        nowEpochMs: authority.nowEpochMs
    });
}

function computeWorkTopology(
    input: ComputeRtcTopologyWorkInput,
    reshape: TopologyReshapePermission
): ReconcileGroupTopologyResult {
    const work = input.facts.workEnvelope.data;
    return computeGroupTopologyFromAuthority(input.read.authority, input.read.mutation.snapshot?.value, {
        intent: work.kind === 'group-revision' ? 'membership-delta' : 'full-rebuild',
        origin: toTopologyWorkOrigin(work),
        reshape
    });
}

function computeWorkReshapeGate(
    read: RtcTopologyWorkRead,
    outcome: TopologyReshapeGatePlanOutcome
): ComputedTopologyReshapeGate {
    return computeTopologyReshapeGate({
        previous: read.reshapeGate?.state ?? null,
        bounds: read.authority.reshapeBounds,
        nowEpochMs: read.authority.nowEpochMs,
        outcome
    });
}

function toFrozenTopologyWork(
    input: ComputeRtcTopologyWorkInput,
    current: RallarOverlayTopologySnapshot
): FrozenRtcTopologyWork {
    const { authority, promotion: promotionRead } = input.read;
    return {
        decision: 'skipped-frozen',
        work: input.facts.workEnvelope.data,
        group: authority.group,
        promotionRead,
        criterionPetition: { authority, planned: current }
    };
}

/**
 * The stored layout stays when the plan equals it and covers the presence the authority carries. A reshape the plan
 * held is still recorded on the gate, so a hold can be the whole outcome.
 */
function computeUnchangedTopologyWork(input: ComputeUnchangedTopologyWorkInput): UnchangedRtcTopologyWork | null {
    const { planned, inputFingerprint } = input;
    const { read } = input.work;
    const { authority, mutation, promotion: promotionRead } = read;
    const work = input.work.facts.workEnvelope.data;
    const stored = mutation.snapshot;
    const unchangedGated = isChangeGatedGroupRevisionWork(work) || work.kind !== 'group-revision';
    if (
        !unchangedGated || stored === null || planned.changed ||
        !hasRequiredPresenceCoverage(stored.value, authority.group.causalRevision.presenceRevision)
    ) {
        return null;
    }
    return {
        decision: 'skipped-unchanged',
        work,
        group: authority.group,
        inputFingerprint,
        promotionRead,
        criterionPetition: { authority, planned: stored.value },
        planningObservation: planned.planningObservation,
        reshape: input.reshape.reshape,
        reshapeGate: computeWorkReshapeGate(read, { kind: 'kept', heldReasons: planned.heldReshapeReasons })
    };
}

/**
 * Only an RTT refresh against an active stored layout is judged by that layout's age: a held one keeps it. Membership
 * work always replans at once.
 */
function computeRttReplan(
    input: ComputeRtcTopologyWorkInput,
    inputFingerprint: string
): PromotedRttReplan | HeldRtcTopologyWork | null {
    const { authority, mutation, storedInputFingerprint } = input.read;
    if (input.facts.workEnvelope.data.kind !== 'rtt-refresh') {
        return null;
    }
    const stored = mutation.snapshot?.value;
    if (stored?.state !== 'active') {
        return { decision: 'promote', reason: 'no-active-layout' };
    }
    const promotion = resolveRttReplanPromotion({
        stored,
        storedInputFingerprint,
        inputFingerprint,
        presenceRevision: authority.group.causalRevision.presenceRevision,
        rttReplanMinimumLayoutAgeMs: authority.rttReplanMinimumLayoutAgeMs,
        nowEpochMs: authority.nowEpochMs
    });
    return promotion.decision === 'hold' ? toHeldTopologyWork(input, promotion, stored) : promotion;
}

/** A hold is resolved only against an active stored layout, which stays and is what the criterion sees. */
function toHeldTopologyWork(
    input: ComputeRtcTopologyWorkInput,
    rttReplanPromotion: HeldRttReplan,
    stored: RallarOverlayTopologySnapshot
): HeldRtcTopologyWork {
    const { authority, promotion: promotionRead } = input.read;
    return {
        decision: 'held-young-layout',
        work: input.facts.workEnvelope.data,
        group: authority.group,
        promotionRead,
        criterionPetition: { authority, planned: stored },
        rttReplanPromotion
    };
}

function computeFingerprintSkip(
    input: ComputeRtcTopologyWorkInput,
    inputFingerprint: string
): Extract<AcceptedRtcTopologyWork, { decision: 'skipped-fingerprint'; }> | null {
    const { authority, promotion: promotionRead, storedInputFingerprint } = input.read;
    const work = input.facts.workEnvelope.data;
    const snapshot = input.read.mutation.snapshot;
    if (!isChangeGatedGroupRevisionWork(work) || snapshot?.value.state !== 'active') {
        return null;
    }
    return storedInputFingerprint === inputFingerprint &&
            hasRequiredPresenceCoverage(snapshot.value, authority.group.causalRevision.presenceRevision)
        ? {
            decision: 'skipped-fingerprint',
            work,
            group: authority.group,
            promotionRead,
            criterionPetition: { authority, planned: snapshot.value }
        }
        : null;
}

function hasRequiredPresenceCoverage(
    snapshot: RallarOverlayTopologySnapshot,
    requiredPresenceRevision: number
): boolean {
    return snapshot.sourceGroupStateCausalRevision.presenceRevision >= requiredPresenceRevision;
}

function computeAcceptedTopologyMutation(
    input: ComputeAcceptedTopologyMutationInput
): Either<Extract<RtcTopologyMutationComputed, { outcome: 'retry'; }>, AcceptedRtcTopologyWork> {
    const { read, planned, inputFingerprint } = input;
    const { authority, promotion: promotionRead } = read;
    const plan = computeAcceptedPlanRecord(input);
    const mutationInput: RtcTopologyMutationInput = {
        read: read.mutation,
        candidate: planned.snapshot,
        ...computeAcceptedTopologyPublication(input, plan)
    };
    const computed = computeTopologyMutation(mutationInput);
    if (computed.outcome === 'retry') {
        return Either.ofLeft(computed);
    }
    if (computed.outcome === 'loaded') {
        throw new TypeError('RTC topology publication claim appeared on a claim-miss path');
    }
    return Either.ofRight({
        decision: 'accepted',
        work: input.facts.workEnvelope.data,
        group: authority.group,
        computed,
        mutationInput,
        publication: mutationInput.publication,
        inputFingerprint,
        promotionRead,
        criterionPetition: { authority, planned: planned.snapshot },
        planningObservation: planned.planningObservation,
        rttReplanPromotion: input.rttReplanPromotion,
        reshape: input.reshape.reshape,
        reshapeGate: computed.outcome === 'write' && plan !== null && planned.derivation !== null
            ? computeWorkReshapeGate(read, toTopologyReshapeGatePlanOutcome(planned.derivation, plan))
            : UNCHANGED_TOPOLOGY_RESHAPE_GATE
    });
}

/** What a written active layout did, as the gate reads it: the change is the plan record's own. */
function toTopologyReshapeGatePlanOutcome(
    derivation: RtcTopologyPlanDerivation,
    plan: RtcTopologyPlanRecord
): TopologyReshapeGatePlanOutcome {
    if (derivation.method === 'established') {
        return { kind: 'established' };
    }
    return plan.change?.kind === 'reshape'
        ? { kind: 'reshape' }
        : { kind: 'kept', heldReasons: plan.heldReshapeReasons };
}

function computeAcceptedTopologyPublication(
    input: ComputeAcceptedTopologyMutationInput,
    plan: RtcTopologyPlanRecord | null
): Pick<RtcTopologyMutationInput, 'publication' | 'facts'> {
    const { publicationExpireAtTimestamp } = input;
    const { workEnvelope, workId, attemptCount, traceId } = input.facts;
    if (publicationExpireAtTimestamp === null) {
        return {
            publication: null,
            facts: { publicationExpireAtTimestamp: null, commandHash: null, attemptCount: null }
        };
    }
    const publication = toTopologyPublication({
        group: input.read.authority.group,
        snapshot: input.planned.snapshot,
        plan,
        facts: {
            workId,
            createdAtEpochMs: workEnvelope.data.requestedAtEpochMs,
            expiresAtEpochMs: publicationExpireAtTimestamp,
            traceId
        }
    });
    return {
        publication,
        facts: {
            publicationExpireAtTimestamp,
            commandHash: computeRtcTopologyExecutionCommandDigest(publication),
            attemptCount
        }
    };
}

/** The record of an active plan, computed once for its publication and for the reshape gate; null for a removal. */
function computeAcceptedPlanRecord(input: ComputeAcceptedTopologyMutationInput): RtcTopologyPlanRecord | null {
    const { planned } = input;
    if (planned.snapshot.state === 'removed' || planned.derivation === null) {
        return null;
    }
    const work = input.facts.workEnvelope.data;
    return computeRtcTopologyPlanRecord({
        stored: input.read.mutation.snapshot?.value ?? null,
        planned: planned.snapshot,
        rttRefresh: work.kind === 'rtt-refresh',
        changeGated: isChangeGatedGroupRevisionWork(work),
        derivation: planned.derivation,
        heldReshapeReasons: planned.heldReshapeReasons,
        nowEpochMs: input.read.authority.nowEpochMs
    });
}

function toTopologyPublication(input: ToTopologyPublicationInput): RtcTopologyPublication {
    const { group, snapshot, plan, facts } = input;
    const { workId } = facts;
    return {
        publicationId: toRtcTopologyPublicationId({
            workId,
            sourceGroupStateCausalRevision: snapshot.sourceGroupStateCausalRevision,
            overlayVersion: snapshot.version
        }),
        workId,
        groupRef: toCanonicalGroupRef(group.group),
        sourceGroupStateCausalRevision: snapshot.sourceGroupStateCausalRevision,
        overlayVersion: snapshot.version,
        targetGroupSnapshotVersion: group.group.snapshotVersion,
        recipientSessionIds: snapshot.activeSessionIds,
        snapshot,
        plan,
        expiresAtEpochMs: facts.expiresAtEpochMs,
        createdAtEpochMs: facts.createdAtEpochMs,
        traceId: facts.traceId
    };
}
