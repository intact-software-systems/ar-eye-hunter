import { toRtcTopologyPublicationId } from '@shared-server/rallar-system/topology/persistence/rtc-topology-identifiers.ts';
import type { GroupTopologyPlanningAuthority } from '@shared-server/rallar-system/topology/planning/group-topology-planning-authority.ts';
import { hashRtcTopologyExecutionCommand } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository-contracts.ts';
import type { RtcTopologyPublication } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication.ts';
import { toCanonicalGroupRef, type GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { ResourceInboxReservationFinish } from '../../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import { RuntimeStateWriteConflictError } from '../../../../runtime-state/optimistic-runtime-state-write.ts';
import { validateComputedProjection } from '../../../computed-data-validation.ts';
import { GroupTopologyValidationError } from '../../group-topology-errors.ts';
import {
    computeTopologyMutation,
    validateTopologyMutation,
    type RtcTopologyMutationInput,
    type RtcTopologyMutationRead
} from '../../mutation/rtc-topology-mutations.ts';
import {
    computeGroupTopologyFromAuthority,
    validateComputedTopologySnapshot
} from '../../planning/compute-group-topology-from-authority.ts';
import type { ReconcileGroupTopologyResult } from '../../planning/group-topology-planning-contracts.ts';
import {
    materializeRtcOverlayTopologyBroadcastMessage,
    type RtcOverlayTopologyMessageFacts
} from '../../planning/materialize-rtc-overlay-topology-broadcast-message.ts';
import {
    computeRtcTopologyWorkWrite,
    type AcceptedRtcTopologyWork,
    type AcceptedRtcTopologyWorkWrite,
    type ComputeRtcTopologyWorkWriteInput
} from './compute-rtc-topology-work-write.ts';
import { isChangeGatedGroupRevisionWork, toTopologyWorkOrigin } from './rtc-topology-coalesced-group-revision-work.ts';
import { computeAuthorityTopologyInputFingerprint } from './rtc-topology-input-fingerprint.ts';
import {
    toRtcTopologyExecutionId,
    type PersistedRtcTopologyWork,
    type RtcTopologyWorkEnvelope
} from './rtc-topology-work-codec.ts';
import type { TopologyPromotionRead } from './topology-promotion-request.ts';

export interface RtcTopologyWorkFacts {
    readonly workEnvelope: RtcTopologyWorkEnvelope<PersistedRtcTopologyWork>;
    readonly workId: string;
    readonly attemptCount: number;
    readonly expireAtEpochMs: number;
}

export interface RtcTopologyWorkRead {
    readonly mutation: RtcTopologyMutationRead;
    readonly authority: GroupTopologyPlanningAuthority;
    readonly promotion: TopologyPromotionRead | null;
    readonly storedInputFingerprint: string | null;
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

export interface RtcTopologyWorkValidationIssue {
    readonly path: string;
    readonly message: string;
    readonly cause: Error;
}

interface ComputeFingerprintSkipInput {
    readonly facts: RtcTopologyWorkFacts;
    readonly mutationRead: RtcTopologyMutationRead;
    readonly authority: GroupTopologyPlanningAuthority;
    readonly inputFingerprint: string;
    readonly promotionRead: TopologyPromotionRead | null;
    readonly storedInputFingerprint: string | null;
}

interface ComputeAcceptedTopologyMutationInput {
    readonly facts: RtcTopologyWorkFacts;
    readonly mutationRead: RtcTopologyMutationRead;
    readonly authority: GroupTopologyPlanningAuthority;
    readonly planned: Extract<ReconcileGroupTopologyResult, { action: 'planned'; }>;
    readonly inputFingerprint: string;
    readonly promotionRead: TopologyPromotionRead | null;
    readonly publicationExpireAtTimestamp: number | null;
}

interface ToTopologyPublicationInput {
    readonly envelope: RtcTopologyWorkEnvelope<PersistedRtcTopologyWork>;
    readonly group: GroupSnapshot;
    readonly snapshot: RallarOverlayTopologySnapshot;
    readonly facts: RtcOverlayTopologyMessageFacts;
}

export async function computeRtcTopologyWork(
    input: ComputeRtcTopologyWorkInput
): Promise<ComputedRtcTopologyWork> {
    const accepted = await computeAcceptedRtcTopologyWork(input);
    return {
        accepted,
        write: computeRtcTopologyWorkWrite(toRtcTopologyWorkWriteInput(input, accepted))
    };
}

export async function validateRtcTopologyWork(
    input: ComputeRtcTopologyWorkInput,
    computed: ComputedRtcTopologyWork
): Promise<readonly RtcTopologyWorkValidationIssue[]> {
    const expected = await computeRtcTopologyWork(input);
    return [
        ...validateComputedProjection(expected, computed, 'computed'),
        ...validateAcceptedTopologyDecision(expected.accepted)
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
        reservationFinish: input.reservationFinish,
        formationAutomationEnabled: input.formationAutomationEnabled,
        serviceId: input.serviceId,
        publisherStreamId: input.publisherStreamId
    };
}

async function computeAcceptedRtcTopologyWork(
    input: ComputeRtcTopologyWorkInput
): Promise<AcceptedRtcTopologyWork> {
    const { facts, read } = input;
    const work = facts.workEnvelope.data;
    const { authority, promotion: promotionRead, storedInputFingerprint } = read;
    const inputFingerprint = await computeAuthorityTopologyInputFingerprint(authority);
    const fingerprintSkip = computeFingerprintSkip({
        facts,
        mutationRead: read.mutation,
        authority,
        inputFingerprint,
        promotionRead,
        storedInputFingerprint
    });
    if (fingerprintSkip !== null) {
        return fingerprintSkip;
    }
    const computedTopology = computeGroupTopologyFromAuthority(
        authority,
        read.mutation.snapshot?.value,
        {
            intent: work.kind === 'group-revision' ? 'membership-delta' : 'full-rebuild',
            origin: toTopologyWorkOrigin(work)
        }
    );
    if (computedTopology.action === 'frozen') {
        return {
            decision: 'skipped-frozen',
            work,
            group: authority.group,
            promotionRead,
            criterionPetition: { authority, planned: computedTopology.current }
        };
    }
    const unchangedGated = isChangeGatedGroupRevisionWork(work) || work.kind !== 'group-revision';
    if (unchangedGated && read.mutation.snapshot !== null && !computedTopology.changed) {
        return {
            decision: 'skipped-unchanged',
            work,
            group: authority.group,
            inputFingerprint,
            promotionRead,
            criterionPetition: { authority, planned: read.mutation.snapshot.value },
            planningObservation: computedTopology.planningObservation
        };
    }
    return await computeAcceptedTopologyMutation({
        facts,
        mutationRead: read.mutation,
        authority,
        planned: computedTopology,
        inputFingerprint,
        promotionRead,
        publicationExpireAtTimestamp: input.publicationExpireAtTimestamp
    });
}

function computeFingerprintSkip(
    input: ComputeFingerprintSkipInput
): Extract<AcceptedRtcTopologyWork, { decision: 'skipped-fingerprint'; }> | null {
    const { facts, mutationRead, authority, inputFingerprint, promotionRead, storedInputFingerprint } = input;
    const work = facts.workEnvelope.data;
    const snapshot = mutationRead.snapshot;
    if (!isChangeGatedGroupRevisionWork(work) || snapshot?.value.state !== 'active') {
        return null;
    }
    return storedInputFingerprint === inputFingerprint
        ? {
            decision: 'skipped-fingerprint',
            work,
            group: authority.group,
            promotionRead,
            criterionPetition: { authority, planned: snapshot.value }
        }
        : null;
}

async function computeAcceptedTopologyMutation(
    input: ComputeAcceptedTopologyMutationInput
): Promise<AcceptedRtcTopologyWork> {
    const { authority, planned, inputFingerprint, promotionRead, publicationExpireAtTimestamp } = input;
    const { workEnvelope, workId, attemptCount } = input.facts;
    const work = workEnvelope.data;
    const publication = publicationExpireAtTimestamp === null
        ? null
        : toTopologyPublication({
            envelope: workEnvelope,
            group: authority.group,
            snapshot: planned.snapshot,
            facts: {
                workId,
                createdAtEpochMs: work.requestedAtEpochMs,
                expiresAtEpochMs: publicationExpireAtTimestamp
            }
        });
    const facts = publication && publicationExpireAtTimestamp !== null
        ? {
            publicationExpireAtTimestamp,
            commandHash: await hashRtcTopologyExecutionCommand(publication),
            attemptCount
        }
        : ({ publicationExpireAtTimestamp: null, commandHash: null, attemptCount: null } as const);
    const mutationInput: RtcTopologyMutationInput = {
        read: input.mutationRead,
        candidate: planned.snapshot,
        publication,
        facts
    };
    const computed = computeTopologyMutation(mutationInput);
    if (computed.outcome === 'retry') {
        throw new RuntimeStateWriteConflictError();
    }
    if (computed.outcome === 'loaded') {
        throw new TypeError('RTC topology publication claim appeared on a claim-miss path');
    }
    return {
        decision: 'accepted',
        work,
        group: authority.group,
        computed,
        mutationInput,
        publication,
        inputFingerprint,
        promotionRead,
        criterionPetition: { authority, planned: planned.snapshot },
        planningObservation: planned.planningObservation
    };
}

function toTopologyPublication(input: ToTopologyPublicationInput): RtcTopologyPublication {
    const { envelope, group, snapshot, facts } = input;
    const workId = toRtcTopologyExecutionId(envelope);
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
        message: materializeRtcOverlayTopologyBroadcastMessage(group, snapshot, facts),
        createdAtEpochMs: facts.createdAtEpochMs
    };
}
