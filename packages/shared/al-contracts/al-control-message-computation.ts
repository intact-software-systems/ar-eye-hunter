import type { ALMessage } from './al-contract.ts';
import type {
    ALAckPayload,
    ALAckStatus,
    ALNackPayload,
    ALNackReason,
    ALRepairPayload,
    ALRepairReason
} from './al-control.ts';
import {
    computeALUnicastMessage,
    type ALMessageConstructionFacts
} from './al-message-computation.ts';
import type { ALQosPolicyRequest } from './al-policy.ts';
import type { ALOrderingObservation } from './al-runtime.ts';

export const AL_CONTROL_ACK_TYPE_ID = 'al.control.ack.v1';
export const AL_CONTROL_NACK_TYPE_ID = 'al.control.nack.v1';
export const AL_CONTROL_REPAIR_TYPE_ID = 'al.control.repair.v1';

const ACKNOWLEDGEMENT_QOS = {
    delivery: { algo: 'best-effort' },
    durability: { algo: 'volatile' },
    ack: { algo: 'none', opts: { timeoutMs: 250 } }
} satisfies ALQosPolicyRequest;

const RETRIED_CONTROL_QOS = {
    delivery: { algo: 'at-least-once' },
    durability: { algo: 'local-outbox' },
    retry: { algo: 'exp-backoff', opts: { maxAttempts: 3 } },
    ack: { algo: 'none', opts: { timeoutMs: 250 } }
} satisfies ALQosPolicyRequest;

export interface ALControlMessageConstructionFacts extends ALMessageConstructionFacts {
    readonly observedAtEpochMs: number;
}

export type ALControlMessageComputationInput =
    | Readonly<{
        kind: 'ack';
        senderId: string;
        toPeerId: string;
        ackedMsgId: string;
        status: ALAckStatus;
        facts: ALControlMessageConstructionFacts;
    }>
    | Readonly<{
        kind: 'nack';
        senderId: string;
        toPeerId: string;
        msgId: string;
        reason: ALNackReason;
        ordering: ALOrderingObservation | undefined;
        serverSnapshotVersion?: number;
        facts: ALControlMessageConstructionFacts;
    }>
    | Readonly<{
        kind: 'repair';
        senderId: string;
        toPeerId: string;
        msgId: string;
        reason: ALRepairReason;
        ordering: ALOrderingObservation | undefined;
        facts: ALControlMessageConstructionFacts;
    }>;

export function computeALControlMessage(input: ALControlMessageComputationInput): ALMessage {
    const common = {
        fromPeerId: input.senderId,
        toPeerId: input.toPeerId,
        observedAtEpochMs: input.facts.observedAtEpochMs
    };
    switch (input.kind) {
        case 'ack':
            return computeControlMessage(
                input,
                AL_CONTROL_ACK_TYPE_ID,
                { ...common, ackedMsgId: input.ackedMsgId, status: input.status }
            );
        case 'nack':
            return computeControlMessage(input, AL_CONTROL_NACK_TYPE_ID, {
                ...common,
                msgId: input.msgId,
                reason: input.reason,
                ...toOrderingPayload(input.ordering),
                serverSnapshotVersion: input.serverSnapshotVersion
            });
        case 'repair':
            return computeControlMessage(input, AL_CONTROL_REPAIR_TYPE_ID, {
                ...common,
                msgId: input.msgId,
                reason: input.reason,
                ...toOrderingPayload(input.ordering)
            });
    }
}

function computeControlMessage(
    input: ALControlMessageComputationInput,
    typeId: string,
    resource: ALAckPayload | ALNackPayload | ALRepairPayload
): ALMessage {
    const referencedMessageId = input.kind === 'ack' ? input.ackedMsgId : input.msgId;
    return computeALUnicastMessage({
        senderId: input.senderId,
        route: {
            topicId: 'al-control',
            resourceId: `${referencedMessageId}:${typeId}`,
            contextId: `${input.senderId}:${input.toPeerId}`
        },
        toPeerId: input.toPeerId,
        typeId,
        resource,
        facts: input.facts,
        options: {
            qos: input.kind === 'ack' ? ACKNOWLEDGEMENT_QOS : RETRIED_CONTROL_QOS
        }
    });
}

function toOrderingPayload(ordering: ALOrderingObservation | undefined) {
    return {
        orderingKey: ordering?.trackKey,
        expectedSeq: ordering?.expectedSeq,
        missingSeqs: ordering?.missingSeqs
    };
}
