import type { ALMessage, ALRoute } from './al-contract.ts';
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
import type { ALOrderingObservation } from './al-runtime.ts';

export const AL_CONTROL_ACK_TYPE_ID = 'al.control.ack.v1';
export const AL_CONTROL_NACK_TYPE_ID = 'al.control.nack.v1';
export const AL_CONTROL_REPAIR_TYPE_ID = 'al.control.repair.v1';

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
    const typeId = toALControlTypeId(input.kind);
    return computeALUnicastMessage({
        senderId: input.senderId,
        route: toControlRoute(input, typeId),
        toPeerId: input.toPeerId,
        typeId,
        resource: toALControlPayload(input),
        facts: input.facts,
        options: { qos: toALControlQos(input.kind) }
    });
}

function toALControlPayload(
    input: ALControlMessageComputationInput
): ALAckPayload | ALNackPayload | ALRepairPayload {
    const common = {
        fromPeerId: input.senderId,
        toPeerId: input.toPeerId,
        observedAtEpochMs: input.facts.observedAtEpochMs
    };
    switch (input.kind) {
        case 'ack':
            return { ...common, ackedMsgId: input.ackedMsgId, status: input.status };
        case 'nack':
            return {
                ...common,
                msgId: input.msgId,
                reason: input.reason,
                ...toOrderingPayload(input.ordering),
                serverSnapshotVersion: input.serverSnapshotVersion
            };
        case 'repair':
            return {
                ...common,
                msgId: input.msgId,
                reason: input.reason,
                ...toOrderingPayload(input.ordering)
            };
    }
}

function toOrderingPayload(ordering: ALOrderingObservation | undefined): Readonly<{
    orderingKey: string | undefined;
    expectedSeq: number | undefined;
    missingSeqs: readonly number[] | undefined;
}> {
    return {
        orderingKey: ordering?.trackKey,
        expectedSeq: ordering?.expectedSeq,
        missingSeqs: ordering?.missingSeqs
    };
}

function toALControlTypeId(kind: ALControlMessageComputationInput['kind']): string {
    switch (kind) {
        case 'ack':
            return AL_CONTROL_ACK_TYPE_ID;
        case 'nack':
            return AL_CONTROL_NACK_TYPE_ID;
        case 'repair':
            return AL_CONTROL_REPAIR_TYPE_ID;
    }
}

function toALControlQos(kind: ALControlMessageComputationInput['kind']) {
    const ack = { algo: 'none' as const, opts: { timeoutMs: 250 } };
    return kind === 'ack'
        ? {
            delivery: { algo: 'best-effort' as const },
            durability: { algo: 'volatile' as const },
            ack
        }
        : {
            delivery: { algo: 'at-least-once' as const },
            durability: { algo: 'local-outbox' as const },
            retry: { algo: 'exp-backoff' as const, opts: { maxAttempts: 3 } },
            ack
        };
}

function toControlRoute(
    input: ALControlMessageComputationInput,
    controlTypeId: string
): ALRoute {
    const msgId = input.kind === 'ack' ? input.ackedMsgId : input.msgId;
    return {
        topicId: 'al-control',
        resourceId: `${msgId}:${controlTypeId}`,
        contextId: `${input.senderId}:${input.toPeerId}`
    };
}
