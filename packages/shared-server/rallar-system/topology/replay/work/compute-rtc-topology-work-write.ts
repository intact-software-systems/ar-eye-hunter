import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { ResourceInboxReservationFinish } from '../../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import { RuntimeStateWriteConflictError } from '../../../../runtime-state/optimistic-runtime-state-write.ts';
import { computeAppOutboxInsert } from '../../../app-outbox/app-outbox-insert.ts';
import { validateComputedProjection } from '../../../computed-data-validation.ts';
import {
    computeTopologyMutation,
    type RtcTopologyMutationComputed,
    type RtcTopologyMutationInput
} from '../../mutation/rtc-topology-mutations.ts';
import type { GroupTopologyPlanningAuthority } from '../../planning/group-topology-planning-authority.ts';
import type { RtcTopologyPublication } from '../../publication/rtc-topology-publication.ts';
import { assertRtcTopologyPublicationOutbox } from '../../publication/rtc-topology-ws-outbox-entry.ts';
import type { RtcTopologyPlanningObservation } from '../../runtime/rtc-topology-metrics.ts';
import type { RtcTopologyDeliveryLogEntry } from '../delivery/rtc-topology-delivery-contracts.ts';
import {
    assertRtcTopologyDeliveryLogEntry,
    RtcTopologyDeliveryCorruptionError
} from '../delivery/rtc-topology-delivery-validation.ts';
import { computePublicationConnectTriggerRequests } from './group-connect-trigger-requests.ts';
import { computeRtcTopologyInputFingerprintWrite } from './rtc-topology-input-fingerprint.ts';
import type { PersistedRtcTopologyWork } from './rtc-topology-work-codec.ts';
import { computeTopologyPromotionRequest } from './topology-promotion-request.ts';
import type { TopologyPromotionRead } from './topology-promotion-request.ts';
import {
    computeRtcTopologyPublicationDeliveryWrite,
    type RtcTopologyPublicationTransactionWrite
} from './write-rtc-topology-publication-transaction.ts';

export type AcceptedRtcTopologyMutation = Exclude<
    RtcTopologyMutationComputed,
    Readonly<{ outcome: 'loaded' | 'retry'; }>
>;

/** A formation criterion check deferred until the topology write commits. */
export interface CommittedCriterionPetition {
    readonly authority: GroupTopologyPlanningAuthority;
    readonly planned: RallarOverlayTopologySnapshot;
}

export type AcceptedRtcTopologyWork =
    | Readonly<{
        decision: 'accepted';
        work: PersistedRtcTopologyWork;
        group: GroupSnapshot;
        computed: AcceptedRtcTopologyMutation;
        mutationInput: RtcTopologyMutationInput;
        publication: RtcTopologyPublication | null;
        inputFingerprint: string;
        promotionRead: TopologyPromotionRead | null;
        criterionPetition: CommittedCriterionPetition | null;
        planningObservation: RtcTopologyPlanningObservation | null;
    }>
    | Readonly<{
        decision: 'skipped-fingerprint';
        work: PersistedRtcTopologyWork;
        group: GroupSnapshot;
        promotionRead: TopologyPromotionRead | null;
        criterionPetition: CommittedCriterionPetition;
    }>
    | Readonly<{
        decision: 'skipped-unchanged';
        work: PersistedRtcTopologyWork;
        group: GroupSnapshot;
        inputFingerprint: string;
        promotionRead: TopologyPromotionRead | null;
        criterionPetition: CommittedCriterionPetition | null;
        planningObservation: RtcTopologyPlanningObservation | null;
    }>
    | Readonly<{
        decision: 'skipped-frozen';
        work: PersistedRtcTopologyWork;
        group: GroupSnapshot;
        promotionRead: TopologyPromotionRead | null;
        criterionPetition: CommittedCriterionPetition;
    }>
    | Readonly<{
        decision: 'skipped-rtt-refinement';
        work: PersistedRtcTopologyWork;
        group: GroupSnapshot;
    }>;

export type AcceptedRtcTopologyWorkWrite =
    | Readonly<{
        kind: 'completion-only';
        reservationFinish: ResourceInboxReservationFinish;
    }>
    | Readonly<{
        kind: 'transaction';
        transaction: RtcTopologyPublicationTransactionWrite;
    }>;

export interface RtcTopologyReplayRead {
    readonly mutation: RtcTopologyMutationInput['read'];
    readonly outbox: ResourceEntry | null;
    readonly delivery: RtcTopologyDeliveryLogEntry | null;
}

interface ComputeRtcTopologyReplayWriteInput {
    readonly read: RtcTopologyReplayRead;
    readonly reservationFinish: ResourceInboxReservationFinish;
    readonly publisherStreamId: string | undefined;
}

interface ComputedRtcTopologyReplayWrite {
    readonly loaded: Extract<RtcTopologyMutationComputed, { outcome: 'loaded'; }>;
    readonly transaction: RtcTopologyPublicationTransactionWrite;
}

export interface ComputeRtcTopologyWorkWriteInput {
    readonly accepted: AcceptedRtcTopologyWork;
    readonly entry: ResourceEntry;
    readonly reservationFinish: ResourceInboxReservationFinish;
    readonly formationAutomationEnabled: boolean;
    readonly serviceId: string | undefined;
    readonly publisherStreamId: string | undefined;
}

export function computeRtcTopologyWorkWrite(
    input: ComputeRtcTopologyWorkWriteInput
): AcceptedRtcTopologyWorkWrite {
    const { accepted, entry, reservationFinish } = input;
    if (
        accepted.decision === 'skipped-rtt-refinement' ||
        accepted.decision === 'skipped-fingerprint' ||
        (accepted.decision === 'accepted' && accepted.computed.outcome === 'superseded')
    ) {
        return { kind: 'completion-only', reservationFinish };
    }
    const target = accepted.decision === 'accepted'
        ? accepted.computed.outcome === 'write'
            ? accepted.computed.snapshotGuard.candidate
            : null
        : accepted.criterionPetition?.planned ?? null;
    const mutation = accepted.decision === 'accepted' &&
            accepted.computed.outcome !== 'superseded'
        ? accepted.computed
        : null;
    return {
        kind: 'transaction',
        transaction: {
            mutation,
            promotionWrite: toOptionalAppOutboxWrite(computeTopologyPromotionRequest({
                read: accepted.promotionRead,
                serviceId: input.serviceId,
                entry,
                target
            })),
            connectWrites: computePublicationConnectTriggerRequests({
                automationEnabled: input.formationAutomationEnabled,
                target,
                entry
            }).map(computeAppOutboxInsert),
            fingerprint: computeFingerprintWrite(accepted),
            delivery: accepted.decision === 'accepted' && accepted.publication
                ? computeRtcTopologyPublicationDeliveryWrite(
                    accepted.publication,
                    input.publisherStreamId
                )
                : null,
            reservationFinish
        }
    };
}

export function validateRtcTopologyWorkWrite(
    input: ComputeRtcTopologyWorkWriteInput,
    computed: AcceptedRtcTopologyWorkWrite
): ReturnType<typeof validateComputedProjection> {
    return validateComputedProjection(computeRtcTopologyWorkWrite(input), computed, 'computed');
}

export function computeRtcTopologyReplayWrite(
    input: ComputeRtcTopologyReplayWriteInput
): ComputedRtcTopologyReplayWrite {
    const mutationInput = toReplayMutationInput(input.read.mutation);
    const computed = computeTopologyMutation(mutationInput);
    if (computed.outcome !== 'loaded') {
        throw new RuntimeStateWriteConflictError();
    }
    const outbox = input.read.outbox;
    if (outbox === null) {
        throw new RtcTopologyDeliveryCorruptionError(
            `RTC topology publication ${computed.publication.publicationId} has no durable outbox`
        );
    }
    try {
        assertRtcTopologyPublicationOutbox(computed.publication, outbox);
    }
    catch {
        throw new RtcTopologyDeliveryCorruptionError(
            `RTC topology publication ${computed.publication.publicationId} has a conflicting durable outbox`
        );
    }
    const expectedDelivery = computeRtcTopologyPublicationDeliveryWrite(
        computed.publication,
        input.publisherStreamId
    ).deliveryAppend;
    if (expectedDelivery !== null) {
        if (input.read.delivery === null) {
            throw new RtcTopologyDeliveryCorruptionError(
                `RTC topology publication ${computed.publication.publicationId} has no durable delivery`
            );
        }
        assertRtcTopologyDeliveryLogEntry(input.read.delivery, expectedDelivery);
    }
    return {
        loaded: computed,
        transaction: {
            mutation: null,
            promotionWrite: null,
            connectWrites: [],
            fingerprint: null,
            delivery: null,
            reservationFinish: input.reservationFinish
        }
    };
}

export function validateRtcTopologyReplayWrite(
    input: ComputeRtcTopologyReplayWriteInput,
    computed: ComputedRtcTopologyReplayWrite
): ReturnType<typeof validateComputedProjection> {
    return validateComputedProjection(computeRtcTopologyReplayWrite(input), computed, 'computed');
}

function toReplayMutationInput(read: RtcTopologyMutationInput['read']): RtcTopologyMutationInput {
    return {
        read,
        candidate: null,
        publication: null,
        facts: {
            publicationExpireAtTimestamp: null,
            commandHash: null,
            attemptCount: null
        }
    };
}

function computeFingerprintWrite(
    accepted: Exclude<AcceptedRtcTopologyWork, { decision: 'skipped-rtt-refinement' | 'skipped-fingerprint'; }>
) {
    if (
        accepted.decision === 'skipped-frozen' ||
        (accepted.decision === 'accepted' && accepted.computed.outcome !== 'write')
    ) {
        return null;
    }
    return computeRtcTopologyInputFingerprintWrite(
        accepted.group.group,
        accepted.inputFingerprint
    );
}

function toOptionalAppOutboxWrite(entry: ResourceEntry | null) {
    return entry === null ? null : computeAppOutboxInsert(entry);
}
