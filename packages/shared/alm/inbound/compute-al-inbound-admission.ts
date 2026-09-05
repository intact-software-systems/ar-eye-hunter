import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../al-contracts/al-message-resource-limits.ts';
import { resolveALMessageExpireAtMs, type ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import { resolveExpireAtTimestampWithFallback } from '../ALStoreRetention.ts';
import {
    acceptALSupersedenceObservation,
    type ALSupersedenceAcceptance
} from '../compute-al-supersedence-observation.ts';
import type {
    ALInboundAdmissionMutation,
    ALInboundAdmissionRead,
    ALInboundBufferedReleaseReadDto,
    ALInboundCommitBundle,
    ALInboundMessageReadDto
} from './al-inbound-admission-store.ts';
import {
    toALInboundAckEffect,
    toALInboundBufferedReleaseEffects,
    toALInboundForwardingEffects,
    toALInboundLocalDeliveryEffects,
    toALInboundNegativeControlEffects,
    type ALInboundControlEffectInput,
    type ALInboundEffectIntent
} from './al-inbound-effect-intent.ts';
import {
    computeALInboundBufferedReleaseSupersedenceAcceptance,
    computeALInboundOrderingAcceptance
} from './al-inbound-planner-snapshot.ts';
import {
    prepareALInboundCommitBundle,
    type ALInboundEffectFacts
} from './prepare-al-inbound-commit-bundle.ts';
import {
    markALPendingAckLocalReadySnapshot,
    trackALPendingAckSnapshot,
    type ALPendingAckTransition
} from './transition-al-pending-ack.ts';

interface ALInboundAdmissionChanges {
    readonly read: ALInboundMessageReadDto | ALInboundBufferedReleaseReadDto;
    readonly mutations: readonly ALInboundAdmissionMutation[];
    readonly effects: readonly ALInboundEffectIntent[];
}

export interface ComputeALInboundAdmissionInput {
    readonly read: ALInboundAdmissionRead;
    readonly plan: ALMessageHandlingPlan;
    readonly canForward: boolean;
    readonly facts: ALInboundEffectFacts;
}

export interface ComputeALInboundBufferedReleaseInput {
    readonly read: ALInboundBufferedReleaseReadDto;
    readonly plan: ALMessageHandlingPlan;
    readonly facts: ALInboundEffectFacts;
}

function computeALInboundMessageRead(
    read: ALInboundAdmissionRead,
    plan: ALMessageHandlingPlan
): ALInboundMessageReadDto {
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
        msg: read.msg,
        fromPeerId: read.fromPeerId,
        source: read.source,
        nowMs: read.nowMs,
        clientRecord: read.clientRecord,
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
    readonly hadPending: boolean;
    readonly expireAtTimestamp: number | undefined;
    readonly nowMs: number;
    readonly senderId: string;
    readonly retention: ALInboundMessageReadDto['retention'];
}

export function computeALInboundAdmission(
    input: ComputeALInboundAdmissionInput
): ALInboundCommitBundle {
    const finalRead = computeALInboundMessageRead(input.read, input.plan);
    const changes = computeALInboundAdmissionChanges(finalRead, input.canForward);
    return prepareALInboundCommitBundle({ ...changes, facts: input.facts });
}

function computeALInboundAdmissionChanges(
    read: ALInboundMessageReadDto,
    canForward: boolean
): ALInboundAdmissionChanges {
    const controls: ALInboundControlEffectInput = {
        msg: read.msg,
        plan: read.plan,
        fromPeerId: read.fromPeerId
    };
    if (read.plan.dropReason) {
        return {
            read,
            mutations: [],
            effects: toALInboundNegativeControlEffects(controls)
        };
    }

    const shouldForward = canForward && read.plan.forwarding.enabled;
    const acknowledgements = computeIncomingAcknowledgements(read, shouldForward);
    return {
        read,
        mutations: [
            ...toAdmittedMessageMutations(read),
            ...toIncomingDeliveryMutations(read),
            ...acknowledgements.mutations
        ],
        effects: [
            ...(read.plan.localDelivery.deferred
                ? toALInboundNegativeControlEffects(controls)
                : toALInboundLocalDeliveryEffects({
                    msg: read.msg,
                    plan: read.plan
                })),
            ...acknowledgements.immediateEffects,
            ...toALInboundForwardingEffects(controls, shouldForward),
            ...acknowledgements.completedEffects,
            ...toALInboundBufferedReleaseEffects(read)
        ]
    };
}

export function computeALInboundBufferedRelease(
    input: ComputeALInboundBufferedReleaseInput
): ALInboundCommitBundle {
    const changes = computeALInboundBufferedReleaseChanges(
        input.read,
        input.plan,
        computeALInboundBufferedReleaseSupersedenceAcceptance(input.read)
    );
    return prepareALInboundCommitBundle({ ...changes, facts: input.facts });
}

function computeALInboundBufferedReleaseChanges(
    read: ALInboundBufferedReleaseReadDto,
    plan: ALMessageHandlingPlan,
    supersedenceAcceptance: ALSupersedenceAcceptance | undefined
): ALInboundAdmissionChanges {
    const superseded = supersedenceAcceptance?.observation.status === 'superseded';
    const deliverable = !plan.dropReason && plan.localDelivery.enabled && !superseded;
    const acknowledgements = deliverable
        ? computeBufferedAcknowledgements(read, read.snapshot.plan, supersedenceAcceptance)
        : { mutations: [], immediateEffects: [], completedEffects: [] };
    return {
        read,
        mutations: [
            {
                kind: 'set-msg-owner',
                msgId: read.snapshot.msg.id.msgId,
                senderId: read.snapshot.msg.id.senderId,
                source: read.source,
                supersedenceKey: read.snapshot.plan.supersedence.key ?? null,
                expireAtTimestamp: read.nowMs + read.retention.msgOwnerTtlMs
            },
            ...(!deliverable
                ? [{ kind: 'delete-buffered' as const, trackKey: read.snapshot.trackKey, seq: read.snapshot.seq }]
                : []),
            ...(deliverable
                ? toSupersedenceMutations(supersedenceAcceptance, read.snapshot.plan.supersedence.key)
                : []),
            ...acknowledgements.mutations
        ],
        effects: [
            ...(deliverable
                ? toALInboundLocalDeliveryEffects({
                    msg: read.snapshot.msg,
                    plan
                })
                : []),
            ...acknowledgements.immediateEffects,
            ...acknowledgements.completedEffects
        ]
    };
}

function toAdmittedMessageMutations(read: ALInboundMessageReadDto): readonly ALInboundAdmissionMutation[] {
    const mutations: ALInboundAdmissionMutation[] = [
        {
            kind: 'set-msg-owner',
            msgId: read.msg.id.msgId,
            senderId: read.msg.id.senderId,
            source: read.source,
            supersedenceKey: read.plan.supersedence.key ?? null,
            expireAtTimestamp: read.nowMs + read.retention.msgOwnerTtlMs
        }
    ];
    if (read.orderingAcceptance.observation.trackKey && read.orderingAcceptance.nextSnapshot) {
        mutations.push({
            kind: 'set-ordering',
            trackKey: read.orderingAcceptance.observation.trackKey,
            snapshot: read.orderingAcceptance.nextSnapshot
        });
    }
    mutations.push({
        kind: 'set-dedup',
        dedupKey: read.plan.dedupKey,
        expireAtTimestamp: read.nowMs + Math.max(0, read.plan.effective.dedup.opts.windowMs)
    });
    return mutations;
}

function toIncomingDeliveryMutations(read: ALInboundMessageReadDto): readonly ALInboundAdmissionMutation[] {
    const plan = read.plan;
    const mutations = plan.localDelivery.deferred
        ? []
        : [...toSupersedenceMutations(read.supersedenceAcceptance, plan.supersedence.key)];
    if (
        (!plan.localDelivery.enabled && !plan.localDelivery.deferred) ||
        plan.orderingRuntime.trackKey === undefined || plan.orderingRuntime.seq === undefined
    ) {
        return mutations;
    }
    if (plan.localDelivery.deferred && plan.supersedence.enabled && plan.supersedence.key) {
        for (const buffered of read.bufferedSnapshots) {
            if (
                buffered.seq !== plan.orderingRuntime.seq &&
                buffered.plan.supersedence.key === plan.supersedence.key &&
                isNewerMessage(read.msg, buffered.msg)
            ) {
                mutations.push({ kind: 'delete-buffered', trackKey: buffered.trackKey, seq: buffered.seq });
            }
        }
    }
    // Retain the existing ordered-message record until application delivery completes,
    // not merely until admission advances the contiguous sequence.
    mutations.push({
        kind: 'set-buffered',
        snapshot: { trackKey: plan.orderingRuntime.trackKey, seq: plan.orderingRuntime.seq, msg: read.msg, plan },
        expireAtTimestamp: resolveExpireAtTimestampWithFallback(
            resolveALMessageExpireAtMs(read.msg, plan.effective),
            read.retention.bufferedMessageTtlMs,
            read.nowMs
        )
    });
    return mutations;
}

function toSupersedenceMutations(
    acceptance: ALInboundMessageReadDto['supersedenceAcceptance'],
    supersedenceKey: string | undefined
): readonly ALInboundAdmissionMutation[] {
    if (!acceptance?.latestWrite || !supersedenceKey) {
        return [];
    }
    return [
        { kind: 'set-supersedence-latest', supersedenceKey, value: acceptance.latestWrite },
        ...acceptance.replacementWrites.map((replacement): ALInboundAdmissionMutation => ({
            kind: 'set-supersedence-replacement',
            msgId: replacement.msgId,
            value: replacement.value
        }))
    ];
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
                status: shouldForward ? 'forwarded' : 'delivered',
                expireAtTimestamp
            })]
        };
    }
    const transition = trackALPendingAckSnapshot({
        msgId: read.msg.id.msgId,
        current: read.pendingAck,
        acks: read.acks,
        toPeerId: plan.ack.toPeerId,
        expectedFromPeerIds: plan.forwarding.nextHopPeerIds,
        localReady: !plan.localDelivery.deferred,
        expireAtTimestamp
    });
    const changes = toAckTransitionChanges(transition, {
        msgId: read.msg.id.msgId,
        senderId: read.msg.id.senderId,
        hadPending: read.pendingAck !== undefined,
        expireAtTimestamp,
        nowMs: read.nowMs,
        retention: read.retention
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

function toControlOwnerMutation(
    read: ALInboundMessageReadDto,
    pendingExpireAtTimestamp: number | undefined
): ALInboundAdmissionMutation {
    return {
        kind: 'set-control-owners',
        msgId: read.msg.id.msgId,
        expected: read.controlOwners,
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
                status: 'delivered',
                expireAtTimestamp
            })]
        };
    }
    const transition = markALPendingAckLocalReadySnapshot({
        msgId: read.snapshot.msg.id.msgId,
        current: read.pendingAck,
        acks: read.acks
    });
    return toAckTransitionChanges(transition, {
        msgId: read.snapshot.msg.id.msgId,
        senderId: read.snapshot.msg.id.senderId,
        hadPending: read.pendingAck !== undefined,
        expireAtTimestamp,
        nowMs: read.nowMs,
        retention: read.retention
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
        : input.hadPending
        ? [{ kind: 'delete-control-pending', msgId: input.msgId, senderId: input.senderId }]
        : [];
    const completedEffects = transition.completed
        ? [toALInboundAckEffect({
            toPeerId: transition.completed.toPeerId,
            ackedMsgId: transition.completed.msgId,
            status: transition.completed.status,
            expireAtTimestamp: transition.completed.expireAtTimestamp ?? input.expireAtTimestamp
        })]
        : [];
    return { mutations, immediateEffects: [], completedEffects };
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

function isNewerMessage(
    candidate: ALMessage,
    existing: ALMessage
): boolean {
    const candidateSeq = candidate.ordering?.seq;
    const existingSeq = existing.ordering?.seq;

    if (candidateSeq !== undefined || existingSeq !== undefined) {
        const seqComparison = (candidateSeq ?? Number.NEGATIVE_INFINITY) -
            (existingSeq ?? Number.NEGATIVE_INFINITY);
        if (seqComparison !== 0) {
            return seqComparison > 0;
        }
    }

    return (candidate.audit?.createdTs ?? candidate.id.ts) > (existing.audit?.createdTs ?? existing.id.ts);
}
