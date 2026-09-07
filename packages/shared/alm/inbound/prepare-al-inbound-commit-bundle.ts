import type { ALMessage } from '../../al-contracts/al-contract.ts';
import {
    newALAckControlMessage,
    newALNackControlMessage,
    newALRepairControlMessage
} from '../../al-contracts/al-control.ts';
import type { ALOrderingObservation } from '../../al-contracts/al-runtime.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import type {
    ALInboundAdmissionMutation,
    ALInboundBufferedReleaseReadDto,
    ALInboundCommitBundle,
    ALInboundDurableEffect,
    ALInboundMessageReadDto
} from './al-inbound-admission-store.ts';
import type { ALInboundEffectIntent } from './al-inbound-effect-intent.ts';

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
    const durableEffects = input.effects.map((effect, index) => ({
        effectId: effect.effectId,
        expireAtTimestamp: effect.expireAtTimestamp ?? read.nowMs + read.retention.durableEffectTtlMs,
        payload: prepareALInboundDurableEffect(effect.payload, facts, index)
    }));
    const ownerExpireAtTimestamp = Math.max(
        read.nowMs + read.retention.msgOwnerTtlMs,
        facts.inboxEntry.audit.expiryTs.epochMilliseconds,
        ...durableEffects.map((effect) => effect.expireAtTimestamp),
        ...input.mutations.flatMap((mutation) =>
            mutation.kind === 'set-buffered' || mutation.kind === 'set-control-pending' ||
                mutation.kind === 'set-control-owners'
                ? [mutation.expireAtTimestamp]
                : []
        )
    );
    return {
        senderId: msg.id.senderId,
        observations: read.observations,
        mutations: input.mutations.map((mutation) =>
            mutation.kind === 'set-msg-owner'
                ? { ...mutation, expireAtTimestamp: ownerExpireAtTimestamp }
                : mutation
        ),
        durableEffects
    };
}

function prepareALInboundDurableEffect(
    payload: ALInboundEffectIntent['payload'],
    facts: ALInboundEffectFacts,
    index: number
): ALInboundDurableEffect {
    const id: ALMessage['id'] = {
        v: 2,
        msgId: `${facts.controlIdPrefix}:${index}`,
        senderId: facts.selfPeerId,
        ts: facts.observedAtEpochMs
    };
    switch (payload.kind) {
        case 'dispatch-local':
        case 'enqueue-inbox':
            return { kind: payload.kind, entry: facts.inboxEntry };
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

function toControlOrdering(ordering: ALOrderingObservation | undefined): ALInboundControlOrdering {
    return {
        ...(ordering?.trackKey === undefined ? {} : { orderingKey: ordering.trackKey }),
        ...(ordering?.expectedSeq === undefined ? {} : { expectedSeq: ordering.expectedSeq }),
        ...(ordering === undefined ? {} : { missingSeqs: ordering.missingSeqs })
    };
}
