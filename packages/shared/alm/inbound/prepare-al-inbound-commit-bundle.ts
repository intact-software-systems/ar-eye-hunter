import { Temporal } from '@js-temporal/polyfill';
import type { ALMessage } from '../../al-contracts/al-contract.ts';
import {
    newALAckControlMessage,
    newALNackControlMessage,
    newALRepairControlMessage
} from '../../al-contracts/al-control.ts';
import { decodePersistedALMessage } from '../../al-contracts/al-message-persistence-validation.ts';
import { toALOrderingTrackKey } from '../../al-contracts/al-runtime.ts';
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
    readonly selfPeerId: string;
    readonly createInboxEntry: (msg: ALMessage) => ResourceEntry;
}

export interface ALInboundEffectFacts {
    readonly selfPeerId: string;
    readonly observedAtEpochMs: number;
    readonly controlIdPrefix: string;
    readonly inboxEntry: ResourceEntry;
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
    readonly expireAtTimestamp: number;
}

/** Captures shell-owned identity and QueueBox values before the pure admission computation. */
export function readALInboundEffectFacts(
    msg: ALMessage,
    nowMs: number,
    dependencies: ALInboundEffectPreparationDependencies
): ALInboundEffectFacts {
    const entry = dependencies.createInboxEntry(msg);
    return {
        selfPeerId: dependencies.selfPeerId,
        observedAtEpochMs: nowMs,
        controlIdPrefix: crypto.randomUUID(),
        inboxEntry: {
            ...entry,
            key: { ...entry.key },
            audit: { ...entry.audit },
            dequeueAudit: { ...entry.dequeueAudit },
            db: entry.db ? { ...entry.db } : undefined
        }
    };
}

export function prepareALInboundCommitBundle(
    input: PrepareALInboundCommitBundleInput
): ALInboundCommitBundle {
    const { read, facts } = input;
    const msg = read.kind === 'incoming' ? read.msg : read.snapshot.msg;
    const durableEffects = input.effects.map((effect, index) => {
        const expireAtTimestamp = effect.expireAtTimestamp ?? read.nowMs + read.retention.durableEffectTtlMs;
        const payload = prepareALInboundDurableEffect({ payload: effect.payload, facts, index, expireAtTimestamp });
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
        senderId: msg.id.senderId,
        observations: read.observations,
        mutations: mutations.map((mutation) =>
            mutation.kind === 'set-msg-owner'
                ? { ...mutation, expireAtTimestamp: ownerExpireAtTimestamp }
                : mutation
        ),
        durableEffects
    };
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
        case 'dispatch-local':
            return { kind: payload.kind, entry: toALInboundDispatchEntry(facts.inboxEntry, input.expireAtTimestamp) };
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
        case 'forward-message':
        case 'release-buffered':
            return payload;
    }
}

export function toALInboundDispatchEntry(entry: ResourceEntry, expireAtTimestamp: number): ResourceEntry {
    return {
        ...entry,
        audit: { ...entry.audit, expiryTs: Temporal.Instant.fromEpochMilliseconds(expireAtTimestamp) }
    };
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
        if (
            payload.kind !== 'dispatch-local' && payload.kind !== 'release-buffered'
        ) {
            continue;
        }
        const msg = payload.kind === 'release-buffered' ? undefined : decodePersistedALMessage(payload.entry.resource);
        const trackKey = payload.kind === 'release-buffered'
            ? payload.trackKey
            : msg === undefined
            ? undefined
            : toALOrderingTrackKey(msg);
        const seq = payload.kind === 'release-buffered' ? payload.seq : msg?.ordering?.seq;
        if (trackKey === undefined || seq === undefined) {
            continue;
        }
        const pendingIndex = mutations.findIndex((mutation) =>
            mutation.kind === 'set-buffered' && mutation.snapshot.trackKey === trackKey && mutation.snapshot.seq === seq
        );
        const pending = mutations[pendingIndex];
        const snapshot = pending?.kind === 'set-buffered'
            ? pending.snapshot
            : snapshots.find((snapshot) => snapshot.trackKey === trackKey && snapshot.seq === seq);
        if (snapshot === undefined || (msg !== undefined && snapshot.msg.id.msgId !== msg.id.msgId)) {
            continue;
        }
        const owned: ALInboundOrderedDeliverySnapshot = {
            ...snapshot,
            delivery: { effectId: effect.effectId }
        };
        const mutation: ALInboundAdmissionMutation = {
            kind: 'set-buffered',
            snapshot: owned,
            expireAtTimestamp: effect.expireAtTimestamp
        };
        if (pendingIndex < 0) {
            mutations.push(mutation);
        }
        else {
            mutations[pendingIndex] = mutation;
        }
    }
    return mutations;
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
