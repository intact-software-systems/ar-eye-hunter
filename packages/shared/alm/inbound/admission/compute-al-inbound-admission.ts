import type { ALAckStatus } from '../../../al-contracts/al-control.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../../al-contracts/al-message-resource-limits.ts';
import { resolveALMessageExpireAtMs, type ALMessageHandlingPlan } from '../../../al-contracts/al-policy.ts';
import { resolveExpireAtTimestampWithFallback } from '../../ALStoreRetention.ts';
import {
    acceptALSupersedenceObservation,
    type ALSupersedenceAcceptance
} from '../../compute-al-supersedence-observation.ts';
import type { ALDeliveryCarrier } from '../../delivery/al-delivery-lifecycle.ts';
import type {
    ALInboundAdmissionMutation,
    ALInboundAdmissionRead,
    ALInboundBufferedReleaseReadDto,
    ALInboundCommitBundle,
    ALInboundDurableEffect,
    ALInboundMessageReadDto
} from '../al-inbound-admission-store.ts';
import {
    toALInboundAckEffect,
    toALInboundBufferedReleaseEffects,
    toALInboundForwardingEffects,
    toALInboundLocalDeliveryEffects,
    toALInboundNegativeControlEffects,
    toALInboundUpwardAcks,
    type ALInboundControlEffectInput,
    type ALInboundEffectIntent
} from '../al-inbound-effect-intent.ts';
import { toALInboundMessageWithDeadline } from '../al-inbound-message-deadline.ts';
import {
    computeALInboundBufferedReleaseSupersedenceAcceptance,
    computeALInboundOrderingAcceptance
} from '../al-inbound-planner-snapshot.ts';
import { toALDeliveryCarrier } from '../al-inbound-source-validation.ts';
import {
    prepareALInboundCommitBundle,
    type ALInboundEffectFacts
} from '../prepare-al-inbound-commit-bundle.ts';
import {
    markALPendingAckLocalReadySnapshot,
    trackALPendingAckSnapshot,
    type ALPendingAckTransition
} from '../transition-al-pending-ack.ts';
import {
    toALInboundAdmittedMessageMutations,
    toALInboundDeliveryMutations,
    toALInboundSupersedenceMutations
} from './al-inbound-delivery-mutations.ts';
import { computeALInboundDuplicateChanges } from './compute-al-inbound-duplicate-changes.ts';

interface ALInboundAdmissionChanges {
    readonly read: ALInboundMessageReadDto | ALInboundBufferedReleaseReadDto;
    readonly mutations: readonly ALInboundAdmissionMutation[];
    readonly effects: readonly ALInboundEffectIntent[];
}

export interface ComputeALInboundAdmissionInput {
    readonly read: ALInboundAdmissionRead;
    readonly plan: ALMessageHandlingPlan;
    readonly canForward: boolean;
    /** Whether the parent a relay row of this message records is still a member of the room and reachable. */
    readonly recordedParentPresent: boolean;
    readonly facts: ALInboundEffectFacts;
}

export interface ComputeALInboundBufferedReleaseInput {
    readonly read: ALInboundBufferedReleaseReadDto;
    readonly plan: ALMessageHandlingPlan;
    readonly facts: ALInboundEffectFacts;
}

export interface ALInboundBufferedRelease extends ALInboundCommitBundle {
    readonly localDelivery:
        | Extract<ALInboundDurableEffect, { readonly kind: 'dispatch-local'; }>
        | undefined;
}

function computeALInboundMessageRead(
    read: ALInboundAdmissionRead,
    plan: ALMessageHandlingPlan
): ALInboundMessageReadDto {
    const expiresAtMs = resolveALMessageExpireAtMs(read.msg, plan.effective);
    const supersedence = plan.supersedence.enabled && plan.supersedence.key
        ? {
            key: plan.supersedence.key,
            msgId: read.msg.id.msgId,
            replacesMsgId: plan.supersedence.replacesMsgId,
            seq: read.msg.ordering?.seq,
            ts: read.msg.audit?.createdTs ?? read.msg.id.ts
        }
        : undefined;
    return {
        kind: 'incoming',
        orderingTrackTtlMs: read.orderingTrackTtlMs,
        namespace: read.namespace,
        msg: expiresAtMs === undefined ? read.msg : toALInboundMessageWithDeadline(read.msg, expiresAtMs),
        fromPeerId: read.fromPeerId,
        source: read.source,
        nowMs: read.nowMs,
        observations: read.observations,
        pendingAck: read.pendingAck,
        acks: read.acks,
        controlOwners: read.controlOwners,
        plan,
        retention: read.retention,
        supersedence: read.supersedence,
        orderingSnapshot: read.orderingSnapshot !== undefined &&
                read.orderingSnapshot.updatedAtMs + read.orderingTrackTtlMs > read.nowMs
            ? read.orderingSnapshot
            : undefined,
        orderingAcceptance: computeALInboundOrderingAcceptance(read, true),
        bufferedSnapshots: read.bufferedSnapshots,
        supersedenceAcceptance: supersedence
            ? acceptALSupersedenceObservation({
                supersedence,
                latest: read.supersedence.latest,
                replacement: read.supersedence.replacement,
                nowMs: read.nowMs,
                trackTtlMs: read.supersedenceTrackTtlMs
            })
            : undefined
    };
}

interface InboundAcknowledgementChanges {
    readonly mutations: readonly ALInboundAdmissionMutation[];
    readonly immediateEffects: readonly ALInboundEffectIntent[];
    readonly completedEffects: readonly ALInboundEffectIntent[];
}

interface InboundPendingAckInput {
    readonly msgId: string;
    readonly expireAtTimestamp: number | undefined;
    readonly nowMs: number;
    readonly senderId: string;
    readonly retention: ALInboundMessageReadDto['retention'];
    readonly carrier: ALDeliveryCarrier;
}

export function computeALInboundAdmission(
    input: ComputeALInboundAdmissionInput
): ALInboundCommitBundle {
    const finalRead = computeALInboundMessageRead(input.read, input.plan);
    const changes = computeALInboundAdmissionChanges(finalRead, input);
    return prepareALInboundCommitBundle({ ...changes, facts: input.facts });
}

function computeALInboundAdmissionChanges(
    read: ALInboundMessageReadDto,
    input: ComputeALInboundAdmissionInput
): ALInboundAdmissionChanges {
    const controls: ALInboundControlEffectInput = {
        msg: read.msg,
        plan: read.plan,
        carrier: toALDeliveryCarrier(read.source),
        fromPeerId: read.fromPeerId
    };
    if (read.plan.dropReason) {
        const duplicate = computeALInboundDuplicateChanges(read, {
            selfPeerId: input.facts.selfPeerId,
            recordedParentPresent: input.recordedParentPresent
        });
        return {
            read,
            mutations: duplicate.mutations,
            effects: [...toALInboundNegativeControlEffects(controls), ...duplicate.effects]
        };
    }

    const shouldForward = input.canForward && read.plan.forwarding.enabled;
    const acknowledgements = computeIncomingAcknowledgements(read, shouldForward);
    return {
        read,
        mutations: [
            ...toALInboundAdmittedMessageMutations(read),
            ...toALInboundDeliveryMutations(read),
            ...acknowledgements.mutations
        ],
        effects: [
            ...(read.plan.localDelivery.deferred
                ? toALInboundNegativeControlEffects(controls)
                : toALInboundLocalDeliveryEffects(controls)),
            ...acknowledgements.immediateEffects,
            ...toALInboundForwardingEffects(controls, shouldForward),
            ...acknowledgements.completedEffects,
            ...toALInboundBufferedReleaseEffects(read)
        ]
    };
}

export function computeALInboundBufferedRelease(
    input: ComputeALInboundBufferedReleaseInput
): ALInboundBufferedRelease {
    const { read, plan, facts } = input;
    const supersedenceAcceptance = computeALInboundBufferedReleaseSupersedenceAcceptance(read);
    const superseded = supersedenceAcceptance?.observation.status === 'superseded';
    const deliverable = !plan.dropReason && plan.localDelivery.enabled && !superseded;
    const acknowledgements = deliverable
        ? computeBufferedAcknowledgements(read, read.snapshot.plan, supersedenceAcceptance)
        : { mutations: [], immediateEffects: [], completedEffects: [] };
    const intent = deliverable
        ? toALInboundLocalDeliveryEffects({ msg: read.snapshot.msg, plan, carrier: read.snapshot.carrier })[0]?.payload
        : undefined;
    const expiresAtMs = resolveALMessageExpireAtMs(read.snapshot.msg, plan.effective);
    const expireAtTimestamp = expiresAtMs ?? read.nowMs + read.retention.durableEffectTtlMs;
    const localDelivery = intent?.kind === 'dispatch-local' ? intent : undefined;
    const bundle = prepareALInboundCommitBundle({
        read,
        facts,
        mutations: [
            {
                kind: 'set-msg-owner',
                value: {
                    msgId: read.snapshot.msg.id.msgId,
                    senderId: read.snapshot.msg.id.senderId,
                    source: read.source,
                    supersedenceKey: read.snapshot.plan.supersedence.key ?? null
                },
                expireAtTimestamp: Math.max(read.nowMs + read.retention.msgOwnerTtlMs, expireAtTimestamp)
            },
            ...(deliverable
                ? toALInboundSupersedenceMutations(
                    supersedenceAcceptance,
                    read.snapshot.plan.supersedence.key
                )
                : []),
            ...acknowledgements.mutations
        ],
        effects: [
            ...acknowledgements.immediateEffects,
            ...acknowledgements.completedEffects
        ]
    });
    return { ...bundle, localDelivery };
}

function computeIncomingAcknowledgements(
    read: ALInboundMessageReadDto,
    shouldForward: boolean
): InboundAcknowledgementChanges {
    const plan = read.plan;
    if (!plan.ack.enabled || !plan.ack.toPeerId) {
        return { mutations: [], immediateEffects: [], completedEffects: [] };
    }
    const expireAtTimestamp = resolveALMessageExpireAtMs(read.msg, plan.effective);
    // No forwarding means there is no subtree to wait for.
    if (!plan.ack.deferred || !shouldForward) {
        return {
            mutations: [],
            completedEffects: [],
            immediateEffects: [toALInboundAckEffect({
                toPeerId: plan.ack.toPeerId,
                ackedMsgId: read.msg.id.msgId,
                originPeerId: read.msg.id.senderId,
                logicalRecipient: { kind: 'self' },
                status: toImmediateAckStatus(plan, shouldForward),
                expireAtTimestamp,
                carrier: toALDeliveryCarrier(read.source)
            })]
        };
    }
    const transition = trackALPendingAckSnapshot({
        msgId: read.msg.id.msgId,
        current: read.pendingAck,
        toPeerId: plan.ack.toPeerId,
        expectedFromPeerIds: plan.forwarding.nextHopPeerIds,
        localReady: !plan.localDelivery.deferred,
        expireAtTimestamp,
        carrier: toALDeliveryCarrier(read.source)
    });
    const changes = toAckTransitionChanges(transition, {
        msgId: read.msg.id.msgId,
        senderId: read.msg.id.senderId,
        expireAtTimestamp,
        nowMs: read.nowMs,
        retention: read.retention,
        carrier: toALDeliveryCarrier(read.source)
    });
    if (!transition.pending) {
        return changes;
    }
    return {
        ...changes,
        mutations: [
            ...changes.mutations,
            toControlOwnerMutation(read, transition.pending.expireAtTimestamp)
        ]
    };
}

/** A peer that delivers nothing, being outside the frozen audience, ends its own empty subtree instead. */
function toImmediateAckStatus(plan: ALMessageHandlingPlan, shouldForward: boolean): ALAckStatus {
    if (shouldForward) {
        return 'forwarded';
    }
    return plan.localDelivery.enabled || plan.localDelivery.deferred ? 'delivered' : 'subtree-complete';
}

function toControlOwnerMutation(
    read: ALInboundMessageReadDto,
    pendingExpireAtTimestamp: number | undefined
): ALInboundAdmissionMutation {
    return {
        kind: 'set-control-owners',
        msgId: read.msg.id.msgId,
        value: computeInboundControlOwnerIndex(
            read.controlOwners,
            read.msg.id.senderId,
            read.plan.forwarding.nextHopPeerIds
        ),
        expireAtTimestamp: resolveExpireAtTimestampWithFallback(
            pendingExpireAtTimestamp,
            read.retention.controlPendingTtlMs,
            read.nowMs
        )
    };
}

function computeBufferedAcknowledgements(
    read: ALInboundBufferedReleaseReadDto,
    plan: ALMessageHandlingPlan,
    supersedenceAcceptance: ALSupersedenceAcceptance | undefined
): InboundAcknowledgementChanges {
    if (
        supersedenceAcceptance?.observation.status === 'superseded' || plan.ack.algo === 'none' ||
        !plan.ack.toPeerId
    ) {
        return { mutations: [], immediateEffects: [], completedEffects: [] };
    }
    const expireAtTimestamp = resolveALMessageExpireAtMs(read.snapshot.msg, plan.effective);
    if (!plan.ack.deferred) {
        return {
            mutations: [],
            completedEffects: [],
            immediateEffects: [toALInboundAckEffect({
                toPeerId: plan.ack.toPeerId,
                ackedMsgId: read.snapshot.msg.id.msgId,
                originPeerId: read.snapshot.msg.id.senderId,
                logicalRecipient: { kind: 'self' },
                status: 'delivered',
                expireAtTimestamp,
                carrier: toALDeliveryCarrier(read.source)
            })]
        };
    }
    const transition = markALPendingAckLocalReadySnapshot({
        msgId: read.snapshot.msg.id.msgId,
        current: read.pendingAck
    });
    return toAckTransitionChanges(transition, {
        msgId: read.snapshot.msg.id.msgId,
        senderId: read.snapshot.msg.id.senderId,
        expireAtTimestamp,
        nowMs: read.nowMs,
        retention: read.retention,
        carrier: toALDeliveryCarrier(read.source)
    });
}

function toAckTransitionChanges(
    transition: ALPendingAckTransition,
    input: InboundPendingAckInput
): InboundAcknowledgementChanges {
    const mutations: ALInboundAdmissionMutation[] = transition.pending
        ? [{
            kind: 'set-control-pending',
            msgId: input.msgId,
            senderId: input.senderId,
            value: { kind: 'pending', value: transition.pending },
            expireAtTimestamp: resolveExpireAtTimestampWithFallback(
                transition.pending.expireAtTimestamp,
                input.retention.controlPendingTtlMs,
                input.nowMs
            )
        }]
        : [];
    return { mutations, immediateEffects: [], completedEffects: toCompletedAckEffects(transition, input) };
}

/** The origin is the tracked message sender, never what a child ACK claimed. */
function toCompletedAckEffects(
    transition: ALPendingAckTransition,
    input: InboundPendingAckInput
): readonly ALInboundEffectIntent[] {
    const pending = transition.pending;
    if (pending === undefined) {
        return [];
    }
    return toALInboundUpwardAcks(transition).map((upward) =>
        toALInboundAckEffect({
            toPeerId: pending.toPeerId,
            ackedMsgId: input.msgId,
            originPeerId: input.senderId,
            logicalRecipient: upward.logicalRecipient,
            status: upward.status,
            expireAtTimestamp: pending.expireAtTimestamp ?? input.expireAtTimestamp,
            carrier: input.carrier
        })
    );
}

function computeInboundControlOwnerIndex(
    current: ALInboundMessageReadDto['controlOwners'],
    senderId: string,
    peerIds: readonly string[]
): NonNullable<ALInboundMessageReadDto['controlOwners']> {
    if (current?.ambiguous) {
        return current;
    }
    const values = new Map(current?.values.map((value) => [value.peerId, value.senderId]) ?? []);
    for (const peerId of peerIds) {
        const existing = values.get(peerId);
        values.set(peerId, existing === undefined || existing === senderId ? senderId : null);
    }
    if (values.size > AL_MESSAGE_RESOURCE_LIMITS.collectionEntries) {
        return { ambiguous: true, values: [] };
    }
    return {
        ambiguous: false,
        values: [...values].map(([peerId, ownerSenderId]) => ({ peerId, senderId: ownerSenderId }))
    };
}
