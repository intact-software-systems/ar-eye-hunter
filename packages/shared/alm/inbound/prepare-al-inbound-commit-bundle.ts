import type { ALMessage } from '../../al-contracts/al-contract.ts';
import {
    newALAckControlMessage,
    newALNackControlMessage,
    newALRepairControlMessage
} from '../../al-contracts/al-control.ts';
import { resolveALMessageExpireAtMs } from '../../al-contracts/al-policy.ts';
import type { ALOrderingObservation } from '../../al-contracts/al-runtime.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import type {
    ALInboundAdmissionMutation,
    ALInboundBufferedReleaseReadDto,
    ALInboundCommitBundle,
    ALInboundDurableEffect,
    ALInboundDurableEffectWrite,
    ALInboundMessageReadDto
} from './al-inbound-admission-store.ts';
import type { ALInboundEffectIntent } from './al-inbound-effect-intent.ts';
import type { ALInboundOrderedDeliverySnapshot } from './al-inbound-ordering-validation.ts';
import { computeALInboundWorkEntry } from './al-inbound-work-entry.ts';

export interface ALInboundEffectPreparationDependencies {
    readonly newControlId: () => string;
    readonly selfPeerId: string;
    readonly createInboxEntry: (msg: ALMessage) => ResourceEntry;
}

export interface ALInboundEffectFacts {
    readonly selfPeerId: string;
    readonly observedAtEpochMs: number;
    readonly controlIdPrefix: string;
}

export interface PrepareALInboundCommitBundleInput {
    readonly read: ALInboundMessageReadDto | ALInboundBufferedReleaseReadDto;
    readonly mutations: readonly ALInboundAdmissionMutation[];
    readonly effects: readonly ALInboundEffectIntent[];
    readonly facts: ALInboundEffectFacts;
}

interface ALInboundControlOrdering {
    readonly orderingKey?: string;
    readonly expectedSeq?: number;
    readonly missingSeqs?: readonly number[];
}

interface PrepareALInboundDurableEffectInput {
    readonly payload: ALInboundEffectIntent['payload'];
    readonly facts: ALInboundEffectFacts;
    readonly index: number;
}

/** Captures shell-owned identity before the pure admission computation. */
export function readALInboundEffectFacts(
    nowMs: number,
    dependencies: ALInboundEffectPreparationDependencies
): ALInboundEffectFacts {
    return {
        selfPeerId: dependencies.selfPeerId,
        observedAtEpochMs: nowMs,
        controlIdPrefix: dependencies.newControlId()
    };
}

export function prepareALInboundCommitBundle(
    input: PrepareALInboundCommitBundleInput
): ALInboundCommitBundle {
    const { read, facts } = input;
    const msg = read.kind === 'incoming' ? read.msg : read.snapshot.msg;
    const durableEffects = input.effects.map((effect, index) => {
        const expireAtTimestamp = effect.expireAtTimestamp ?? read.nowMs + read.retention.durableEffectTtlMs;
        const payload = prepareALInboundDurableEffect({ payload: effect.payload, facts, index });
        // A repeated data admission may emit a new receipt; its work follows that control envelope's own identity.
        const effectId = payload.kind === 'send-control'
            ? `${effect.effectId}:${encodeURIComponent(payload.msg.id.msgId)}`
            : effect.effectId;
        return computeALInboundWorkEntry({
            namespace: read.namespace,
            observedAtMs: facts.observedAtEpochMs,
            effectId,
            expireAtTimestamp,
            payload
        });
    });
    const deliveryMutations = computeDeliveryOwnerMutations(input, durableEffects);
    const mutations = [...deliveryMutations, ...computeDeliveryProgressRetention(input, deliveryMutations)];
    // The canonical message must outlive every effect and buffered slot that only names it.
    const ownerExpireAtTimestamp = Math.max(
        read.nowMs + read.retention.msgOwnerTtlMs,
        ...durableEffects.map((effect) => effect.expireAtTimestamp),
        ...mutations.flatMap((mutation) =>
            mutation.kind === 'set-msg-owner' || mutation.kind === 'set-buffered' ||
                mutation.kind === 'set-control-pending' ||
                mutation.kind === 'set-control-owners'
                ? [mutation.expireAtTimestamp]
                : []
        )
    );
    return {
        admissionExpiresAtMs: read.kind === 'incoming'
            ? resolveALMessageExpireAtMs(msg) ?? read.nowMs + read.retention.durableEffectTtlMs
            : null,
        senderId: msg.id.senderId,
        observations: read.observations,
        mutations: [
            ...toCanonicalMessageMutations(mutations, msg, ownerExpireAtTimestamp),
            ...mutations.map((mutation) =>
                mutation.kind === 'set-msg-owner'
                    ? { ...mutation, expireAtTimestamp: ownerExpireAtTimestamp }
                    : mutation
            )
        ],
        durableEffects
    };
}

/** Admission retains the message once; provenance ownership decides when that row is written. */
function toCanonicalMessageMutations(
    mutations: readonly ALInboundAdmissionMutation[],
    msg: ALMessage,
    expireAtTimestamp: number
): readonly ALInboundAdmissionMutation[] {
    if (!mutations.some((mutation) => mutation.kind === 'set-msg-owner')) {
        return [];
    }
    return [{
        kind: 'set-inbound-message',
        value: { msgId: msg.id.msgId, senderId: msg.id.senderId, msg, retainUntilMs: expireAtTimestamp },
        expireAtTimestamp
    }];
}

function prepareALInboundDurableEffect(input: PrepareALInboundDurableEffectInput): ALInboundDurableEffect {
    const { payload, facts, index } = input;
    const id: ALMessage['id'] = {
        v: 2,
        msgId: `${facts.controlIdPrefix}:${index}`,
        senderId: facts.selfPeerId,
        ts: facts.observedAtEpochMs
    };
    switch (payload.kind) {
        case 'send-ack':
            return {
                kind: 'send-control',
                msg: newALAckControlMessage(id, {
                    fromPeerId: facts.selfPeerId,
                    toPeerId: payload.toPeerId,
                    ackedMsgId: payload.ackedMsgId,
                    status: payload.status,
                    observedAtEpochMs: facts.observedAtEpochMs
                })
            };
        case 'send-nack':
            return {
                kind: 'send-control',
                msg: newALNackControlMessage(id, {
                    ...toControlOrdering(payload.ordering),
                    fromPeerId: facts.selfPeerId,
                    toPeerId: payload.toPeerId,
                    msgId: payload.msgId,
                    reason: payload.reason,
                    observedAtEpochMs: facts.observedAtEpochMs
                })
            };
        case 'send-repair':
            return {
                kind: 'send-control',
                msg: newALRepairControlMessage(id, {
                    ...toControlOrdering(payload.ordering),
                    fromPeerId: facts.selfPeerId,
                    toPeerId: payload.toPeerId,
                    msgId: payload.msgId,
                    reason: payload.reason,
                    observedAtEpochMs: facts.observedAtEpochMs
                })
            };
        case 'dispatch-local':
        case 'forward-message':
        case 'release-buffered':
            return payload;
    }
}

function toControlOrdering(ordering: ALOrderingObservation | undefined): ALInboundControlOrdering {
    return {
        ...(ordering?.trackKey === undefined ? {} : { orderingKey: ordering.trackKey }),
        ...(ordering?.expectedSeq === undefined ? {} : { expectedSeq: ordering.expectedSeq }),
        ...(ordering === undefined ? {} : { missingSeqs: ordering.missingSeqs })
    };
}

function computeDeliveryOwnerMutations(
    input: PrepareALInboundCommitBundleInput,
    effects: readonly ALInboundDurableEffectWrite[]
): readonly ALInboundAdmissionMutation[] {
    const mutations = [...input.mutations];
    const snapshots = input.read.kind === 'incoming' ? input.read.bufferedSnapshots : [input.read.snapshot];
    for (const effect of effects) {
        const payload = effect.payload;
        if (payload.kind !== 'dispatch-local' && payload.kind !== 'release-buffered') {
            continue;
        }
        const pendingIndex = mutations.findIndex((mutation) =>
            mutation.kind === 'set-buffered' && ownsDeliverySlot(payload, mutation.snapshot)
        );
        const pending = mutations[pendingIndex];
        if (pending?.kind === 'set-buffered') {
            // This bundle also writes the owner row of the slot it is creating, so its expiry already covers it.
            mutations[pendingIndex] = toDeliveryOwnerMutation(pending.snapshot, effect, effect.expireAtTimestamp);
            continue;
        }
        const stored = snapshots.find((candidate) => ownsDeliverySlot(payload, candidate));
        if (stored === undefined) {
            continue;
        }
        // A slot must never outlive the owner row it names; only that row's own bundle re-extends it.
        mutations.push(
            toDeliveryOwnerMutation(
                stored,
                effect,
                Math.min(effect.expireAtTimestamp, stored.ownerRetainUntilMs)
            )
        );
    }
    return mutations;
}

function toDeliveryOwnerMutation(
    snapshot: ALInboundOrderedDeliverySnapshot,
    effect: ALInboundDurableEffectWrite,
    expireAtTimestamp: number
): ALInboundAdmissionMutation {
    return {
        kind: 'set-buffered',
        snapshot: {
            trackKey: snapshot.trackKey,
            seq: snapshot.seq,
            msg: snapshot.msg,
            plan: snapshot.plan,
            delivery: { effectId: effect.effectId }
        },
        expireAtTimestamp
    };
}

function ownsDeliverySlot(
    payload: Extract<ALInboundDurableEffect, { readonly kind: 'dispatch-local' | 'release-buffered'; }>,
    snapshot: ALInboundOrderedDeliverySnapshot
): boolean {
    return payload.kind === 'release-buffered'
        ? snapshot.trackKey === payload.trackKey && snapshot.seq === payload.seq
        : snapshot.msg.id.msgId === payload.message.msgId && snapshot.msg.id.senderId === payload.message.senderId;
}

/** Retain completion evidence for the full lifetime of every admitted dependency on its track. */
function computeDeliveryProgressRetention(
    input: PrepareALInboundCommitBundleInput,
    mutations: readonly ALInboundAdmissionMutation[]
): readonly ALInboundAdmissionMutation[] {
    const { read } = input;
    const observed = read.observations.deliveryProgress;
    if (read.kind !== 'incoming' || observed === undefined) {
        return [];
    }
    const buffered = mutations.filter((mutation) => mutation.kind === 'set-buffered');
    if (buffered.length === 0 && !mutations.some((mutation) => mutation.kind === 'set-ordering')) {
        return [];
    }
    return [{
        kind: 'set-delivery-progress',
        trackKey: observed.trackKey,
        value: {
            completedThrough: observed.value?.completedThrough ?? 0,
            expireAtTimestamp: Math.max(
                observed.value?.expireAtTimestamp ?? 0,
                read.nowMs + read.orderingTrackTtlMs,
                ...buffered.map((mutation) => mutation.expireAtTimestamp)
            )
        }
    }];
}
