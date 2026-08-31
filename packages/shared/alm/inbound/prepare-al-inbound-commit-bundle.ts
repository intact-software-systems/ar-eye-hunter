import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type {
    newALAckControlMessage,
    newALNackControlMessage,
    newALRepairControlMessage
} from '../../al-contracts/al-control.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import type { ALInboundCommitBundle, ALInboundDurableEffect } from './al-inbound-admission-store.ts';
import type { ALInboundEffectIntent } from './al-inbound-effect-intent.ts';
import type { ALInboundAdmissionComputed } from './compute-al-inbound-admission.ts';

export interface ALInboundEffectPreparationDependencies {
    readonly selfPeerId: string;
    readonly createInboxEntry: (msg: ALMessage) => ResourceEntry;
    readonly createAckMessage: typeof newALAckControlMessage;
    readonly createNackMessage: typeof newALNackControlMessage;
    readonly createRepairMessage: typeof newALRepairControlMessage;
}

export function prepareALInboundCommitBundle(
    computed: ALInboundAdmissionComputed,
    dependencies: ALInboundEffectPreparationDependencies
): ALInboundCommitBundle {
    const read = computed.read;
    const msg = read.kind === 'incoming' ? read.msg : read.snapshot.msg;
    return {
        senderId: msg.id.senderId,
        expectedVersion: read.clientRecord?.version,
        mutations: computed.mutations,
        durableEffects: computed.effects.map((effect) => ({
            effectId: effect.effectId,
            expireAtTimestamp: effect.expireAtTimestamp,
            payload: prepareALInboundDurableEffect(effect.payload, dependencies)
        }))
    };
}

function prepareALInboundDurableEffect(
    payload: ALInboundEffectIntent['payload'],
    dependencies: ALInboundEffectPreparationDependencies
): ALInboundDurableEffect {
    switch (payload.kind) {
        case 'dispatch-local':
        case 'enqueue-inbox':
            return { ...payload, entry: dependencies.createInboxEntry(payload.msg) };
        case 'send-ack':
            return {
                kind: 'send-control',
                msg: dependencies.createAckMessage(
                    dependencies.selfPeerId,
                    payload.toPeerId,
                    payload.ackedMsgId,
                    payload.status
                )
            };
        case 'send-nack':
            return {
                kind: 'send-control',
                msg: dependencies.createNackMessage(
                    dependencies.selfPeerId,
                    payload.toPeerId,
                    payload.msgId,
                    payload.reason,
                    payload.ordering
                )
            };
        case 'send-repair':
            return {
                kind: 'send-control',
                msg: dependencies.createRepairMessage(
                    dependencies.selfPeerId,
                    payload.toPeerId,
                    payload.msgId,
                    payload.reason,
                    payload.ordering
                )
            };
        case 'forward-message':
        case 'release-buffered':
            return payload;
    }
}
