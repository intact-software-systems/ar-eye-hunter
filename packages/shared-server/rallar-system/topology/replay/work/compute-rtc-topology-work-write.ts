import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

import type { ResourceInboxReservationFinish } from '../../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import { RuntimeStateWriteConflictError } from '../../../../runtime-state/optimistic-runtime-state-write.ts';
import { computeAppOutboxInsert } from '../../../app-outbox/app-outbox-insert.ts';
import {
    computeTopologyMutation,
    validateTopologyMutation,
    type RtcTopologyMutationComputed,
    type RtcTopologyMutationInput
} from '../../mutation/rtc-topology-mutations.ts';
import type { GroupTopologyPlanningAuthority } from '../../planning/group-topology-planning-authority.ts';
import type { RtcTopologyPublication } from '../../publication/rtc-topology-publication.ts';
import { validateRtcTopologyPublicationOutbox } from '../../publication/rtc-topology-ws-outbox-entry.ts';
import type { RtcTopologyPlanningObservation } from '../../runtime/rtc-topology-metrics.ts';
import type { RtcTopologyDeliveryLogEntry } from '../delivery/rtc-topology-delivery-contracts.ts';
import {
    RtcTopologyDeliveryCorruptionError,
    validateRtcTopologyDeliveryLogEntry
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

export interface ComputeRtcTopologyReplayWriteInput {
    readonly read: RtcTopologyReplayRead;
    readonly reservationFinish: ResourceInboxReservationFinish;
    readonly publisherStreamId: string | undefined;
}

export interface ComputedRtcTopologyReplayWrite {
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
): void {
    if (input.accepted.decision === 'accepted') {
        validateTopologyMutation({
            ...input.accepted.mutationInput,
            computed: input.accepted.computed
        });
    }
    const expected = computeRtcTopologyWorkWrite(input);
    if (!jsonEquals(toValidationProjection(computed), toValidationProjection(expected))) {
        throw new TypeError('RTC topology work write differs from its canonical computation');
    }
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
        validateRtcTopologyPublicationOutbox(computed.publication, outbox);
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
        validateRtcTopologyDeliveryLogEntry(input.read.delivery, expectedDelivery);
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
): void {
    validateTopologyMutation({
        ...toReplayMutationInput(input.read.mutation),
        computed: computed.loaded
    });
    const expected = computeRtcTopologyReplayWrite(input);
    if (!jsonEquals(toTransactionProjection(computed.transaction), toTransactionProjection(expected.transaction))) {
        throw new TypeError('RTC topology replay write differs from its canonical computation');
    }
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

function toValidationProjection(computed: AcceptedRtcTopologyWorkWrite): object {
    if (computed.kind === 'completion-only') {
        return {
            kind: computed.kind,
            reservationFinish: toReservationFinishProjection(computed.reservationFinish)
        };
    }
    const transaction = computed.transaction;
    return {
        kind: computed.kind,
        transaction: toTransactionProjection(transaction)
    };
}

function toTransactionProjection(transaction: RtcTopologyPublicationTransactionWrite): object {
    return {
        mutation: transaction.mutation,
        promotionWrite: transaction.promotionWrite === null
            ? null
            : {
                ...transaction.promotionWrite,
                entry: toRequiredResourceEntryProjection(transaction.promotionWrite.entry)
            },
        connectWrites: transaction.connectWrites.map((write) => ({
            ...write,
            entry: toRequiredResourceEntryProjection(write.entry)
        })),
        fingerprint: transaction.fingerprint,
        delivery: transaction.delivery === null
            ? null
            : {
                outboxWrite: {
                    ...transaction.delivery.outboxWrite,
                    entry: toRequiredResourceEntryProjection(
                        transaction.delivery.outboxWrite.entry
                    )
                },
                deliveryAppend: transaction.delivery.deliveryAppend
            },
        reservationFinish: toReservationFinishProjection(transaction.reservationFinish)
    };
}

function toOptionalAppOutboxWrite(entry: ResourceEntry | null) {
    return entry === null ? null : computeAppOutboxInsert(entry);
}

function toReservationFinishProjection(computed: ResourceInboxReservationFinish): object {
    return {
        key: computed.key,
        expectedAttempts: computed.expectedAttempts,
        status: computed.status,
        completedAt: computed.completedAt.toISOString()
    };
}

function toRequiredResourceEntryProjection(entry: Readonly<ResourceEntry>): object {
    return {
        key: entry.key,
        resource: entry.resource,
        typeId: entry.typeId,
        status: entry.status,
        audit: {
            date: entry.audit.date.toString(),
            createdBy: entry.audit.createdBy,
            createdTs: entry.audit.createdTs.toString(),
            expiryTs: entry.audit.expiryTs.toString()
        },
        dequeueAudit: {
            startTs: entry.dequeueAudit.startTs?.toString() ?? null,
            endTs: entry.dequeueAudit.endTs?.toString() ?? null,
            nextTs: entry.dequeueAudit.nextTs?.toString() ?? null,
            attempts: entry.dequeueAudit.attempts
        },
        db: entry.db ?? null
    };
}
