import type { ALMessage } from '../../al-contracts/al-contract.ts';
import {
    computeALAckControlMessage,
    computeALNackControlMessage,
    computeALRepairControlMessage,
    type ALControlMessageConstructionFacts
} from '../../al-contracts/al-control.ts';
import { resolveALMessageExpireAtMs, type ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import {
    computeResourceEntryFromALMessage,
    type ALMessageResourceEntryFacts
} from '../../queuebox/ResourceEntry.ts';
import type {
    ALInboundAdmissionMutation,
    ALInboundBufferedReleaseReadDto,
    ALInboundCommitBundle,
    ALInboundDurableEffect,
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
    markALPendingAckLocalReadySnapshot,
    trackALPendingAckSnapshot,
    type ALPendingAckTransition
} from './transition-al-pending-ack.ts';

interface ALInboundAdmissionDecision {
    readonly read: ALInboundMessageReadDto | ALInboundBufferedReleaseReadDto;
    readonly mutations: readonly ALInboundAdmissionMutation[];
    readonly effects: readonly ALInboundEffectIntent[];
}

export interface ALInboundComputationFacts {
    readonly selfPeerId: string;
    readonly inboxEntryTypeId: string;
    readonly messageIdentitySeed: string;
    readonly observedAtEpochMs: number;
    readonly inboxAudit: ALMessageResourceEntryFacts;
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
}

export function computeALInboundAdmission(
    read: ALInboundMessageReadDto,
    canForward: boolean,
    facts: ALInboundComputationFacts
): ALInboundCommitBundle {
    return computeALInboundCommitBundle(computeALInboundAdmissionDecision(read, canForward), facts);
}

function computeALInboundAdmissionDecision(
    read: ALInboundMessageReadDto,
    canForward: boolean
): ALInboundAdmissionDecision {
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
    read: ALInboundBufferedReleaseReadDto,
    plan: ALMessageHandlingPlan,
    facts: ALInboundComputationFacts
): ALInboundCommitBundle {
    return computeALInboundCommitBundle(computeALInboundBufferedReleaseDecision(read, plan), facts);
}

function computeALInboundBufferedReleaseDecision(
    read: ALInboundBufferedReleaseReadDto,
    plan: ALMessageHandlingPlan
): ALInboundAdmissionDecision {
    const superseded = read.supersedenceAcceptance?.observation.status === 'superseded';
    const deliverable = !plan.dropReason && plan.localDelivery.enabled && !superseded;
    const acknowledgements = deliverable
        ? computeBufferedAcknowledgements(read, read.snapshot.plan)
        : { mutations: [], immediateEffects: [], completedEffects: [] };
    return {
        read,
        mutations: [
            {
                kind: 'set-msg-owner',
                msgId: read.snapshot.msg.id.msgId,
                senderId: read.snapshot.msg.id.senderId
            },
            ...(!deliverable
                ? [{ kind: 'delete-buffered' as const, trackKey: read.snapshot.trackKey, seq: read.snapshot.seq }]
                : []),
            ...(deliverable
                ? toSupersedenceMutations(read.supersedenceAcceptance, read.snapshot.plan.supersedence.key)
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

function computeALInboundCommitBundle(
    computed: ALInboundAdmissionDecision,
    facts: ALInboundComputationFacts
): ALInboundCommitBundle {
    const msg = computed.read.kind === 'incoming' ? computed.read.msg : computed.read.snapshot.msg;
    return {
        senderId: msg.id.senderId,
        expectedVersion: computed.read.clientRecord?.version,
        mutations: computed.mutations,
        durableEffects: computed.effects.map((effect) => ({
            effectId: effect.effectId,
            expireAtTimestamp: effect.expireAtTimestamp,
            payload: computeALInboundDurableEffect(effect.effectId, effect.payload, facts)
        }))
    };
}

function computeALInboundDurableEffect(
    effectId: string,
    payload: ALInboundEffectIntent['payload'],
    facts: ALInboundComputationFacts
): ALInboundDurableEffect {
    switch (payload.kind) {
        case 'dispatch-local':
        case 'enqueue-inbox':
            return {
                kind: payload.kind,
                entry: computeResourceEntryFromALMessage(payload.msg, facts.inboxEntryTypeId, facts.inboxAudit)
            };
        case 'send-ack':
            return {
                kind: 'send-control',
                msg: computeALAckControlMessage(
                    facts.selfPeerId,
                    payload.toPeerId,
                    payload.ackedMsgId,
                    payload.status,
                    toControlMessageFacts(effectId, facts)
                )
            };
        case 'send-nack':
            return {
                kind: 'send-control',
                msg: computeALNackControlMessage(
                    facts.selfPeerId,
                    payload.toPeerId,
                    payload.msgId,
                    payload.reason,
                    payload.ordering,
                    {},
                    toControlMessageFacts(effectId, facts)
                )
            };
        case 'send-repair':
            return {
                kind: 'send-control',
                msg: computeALRepairControlMessage(
                    facts.selfPeerId,
                    payload.toPeerId,
                    payload.msgId,
                    payload.reason,
                    payload.ordering,
                    toControlMessageFacts(effectId, facts)
                )
            };
        case 'forward-message':
        case 'release-buffered':
            return payload;
    }
}

function toControlMessageFacts(
    effectId: string,
    facts: ALInboundComputationFacts
): ALControlMessageConstructionFacts {
    return {
        msgId: `${facts.messageIdentitySeed}:${effectId}`,
        nowEpochMs: facts.observedAtEpochMs,
        observedAtEpochMs: facts.observedAtEpochMs
    };
}

function toAdmittedMessageMutations(read: ALInboundMessageReadDto): readonly ALInboundAdmissionMutation[] {
    const mutations: ALInboundAdmissionMutation[] = [
        { kind: 'set-msg-owner', msgId: read.msg.id.msgId, senderId: read.msg.id.senderId }
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
        snapshot: { trackKey: plan.orderingRuntime.trackKey, seq: plan.orderingRuntime.seq, msg: read.msg, plan }
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
    return toAckTransitionChanges(transition, {
        msgId: read.msg.id.msgId,
        hadPending: read.pendingAck !== undefined,
        expireAtTimestamp
    });
}

function computeBufferedAcknowledgements(
    read: ALInboundBufferedReleaseReadDto,
    plan: ALMessageHandlingPlan
): InboundAcknowledgementChanges {
    if (
        read.supersedenceAcceptance?.observation.status === 'superseded' || plan.ack.algo === 'none' ||
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
        hadPending: read.pendingAck !== undefined,
        expireAtTimestamp
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
            value: { kind: 'pending', value: transition.pending }
        }]
        : input.hadPending
        ? [{ kind: 'delete-control-pending', msgId: input.msgId }]
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
