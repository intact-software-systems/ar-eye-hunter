import { Either } from '../resilience/Either.ts';
import type { ALMessage } from './al-contract.ts';
import {
    decodeALAckPayload,
    decodeALNackPayload,
    decodeALRepairPayload
} from './al-control-value-codec.ts';
import {
    decodeALMessageValue,
    type ALMessageRejection
} from './al-message-persistence-validation.ts';
import {
    AL_MESSAGE_RESOURCE_LIMITS
} from './al-message-resource-limits.ts';

export const AL_CONTROL_ACK_TYPE_ID = 'al.control.ack.v1';
export const AL_CONTROL_NACK_TYPE_ID = 'al.control.nack.v1';
export const AL_CONTROL_REPAIR_TYPE_ID = 'al.control.repair.v1';

export type ALAckStatus = 'accepted' | 'delivered' | 'forwarded' | 'subtree-complete';
export type ALNackReason =
    | 'duplicate'
    | 'gap'
    | 'resync-required'
    | 'expired'
    | 'unauthorized'
    | 'no-route'
    | 'overloaded'
    | 'stale'
    | 'not-yet-in-sync';
export type ALRepairReason = 'missing-seq' | 'retransmit' | 'resync';

export interface ALAckPayload {
    readonly ackedMsgId: string;
    readonly fromPeerId: string;
    readonly toPeerId: string;
    readonly status: ALAckStatus;
    readonly observedAtEpochMs: number;
}

export interface ALNackPayload {
    readonly msgId: string;
    readonly fromPeerId: string;
    readonly toPeerId: string;
    readonly reason: ALNackReason;
    readonly observedAtEpochMs: number;
    readonly orderingKey?: string;
    readonly expectedSeq?: number;
    readonly missingSeqs?: readonly number[];
    readonly serverSnapshotVersion?: number;
}

export interface ALRepairPayload {
    readonly msgId: string;
    readonly fromPeerId: string;
    readonly toPeerId: string;
    readonly reason: ALRepairReason;
    readonly observedAtEpochMs: number;
    readonly orderingKey?: string;
    readonly expectedSeq?: number;
    readonly missingSeqs?: readonly number[];
}

export type ALControlPayload = ALAckPayload | ALNackPayload | ALRepairPayload;

export type ALParsedControlMessage =
    | Readonly<{ type: 'ack'; payload: ALAckPayload; }>
    | Readonly<{ type: 'nack'; payload: ALNackPayload; }>
    | Readonly<{ type: 'repair'; payload: ALRepairPayload; }>;

export interface ALCompletedPendingAck {
    readonly msgId: string;
    readonly toPeerId: string;
    readonly status: ALAckStatus;
    readonly expireAtTimestamp?: number;
}

export interface ALControlAcceptance {
    readonly handled: boolean;
    readonly completedPendingAcks: readonly ALCompletedPendingAck[];
}

export interface ALPendingAckSnapshot {
    readonly toPeerId: string;
    readonly status: ALAckStatus;
    readonly localReady: boolean;
    readonly expectedFromPeerIds: readonly string[];
    readonly ackedFromPeerIds: readonly string[];
    readonly expireAtTimestamp?: number;
}

export type ALControlPersistenceValue =
    | Readonly<{ kind: 'acks'; values: readonly ALAckPayload[]; }>
    | Readonly<{ kind: 'nacks'; values: readonly ALNackPayload[]; }>
    | Readonly<{ kind: 'repairs'; values: readonly ALRepairPayload[]; }>
    | Readonly<{ kind: 'pending'; value: ALPendingAckSnapshot; }>;

export function isALControlTypeId(typeId: string): boolean {
    return typeId === AL_CONTROL_ACK_TYPE_ID ||
        typeId === AL_CONTROL_NACK_TYPE_ID ||
        typeId === AL_CONTROL_REPAIR_TYPE_ID;
}

export function parseALControlMessage(msg: ALMessage): ALParsedControlMessage | undefined {
    switch (msg.payload.typeId) {
        case AL_CONTROL_ACK_TYPE_ID:
            return { type: 'ack', payload: decodeALAckPayload(parseControlPayload(msg.payload.resource)) };
        case AL_CONTROL_NACK_TYPE_ID:
            return { type: 'nack', payload: decodeALNackPayload(parseControlPayload(msg.payload.resource)) };
        case AL_CONTROL_REPAIR_TYPE_ID:
            return { type: 'repair', payload: decodeALRepairPayload(parseControlPayload(msg.payload.resource)) };
        default:
            return undefined;
    }
}

export function decodeALControlMessage(msg: ALMessage): Either<ALMessageRejection, ALParsedControlMessage> {
    const decodedEnvelope = decodeALMessageValue(msg);
    if (decodedEnvelope.left) {
        return Either.ofLeft(decodedEnvelope.left);
    }
    if (!isALControlTypeId(msg.payload.typeId)) {
        return Either.ofLeft({ code: 'unsupported', message: 'AL control type is unsupported' });
    }
    try {
        const parsed = parseALControlMessage(msg)!;
        validateControlEnvelope(msg, parsed.payload);
        return Either.ofRight(parsed);
    }
    catch (error) {
        return Either.ofLeft({
            code: 'malformed',
            message: error instanceof TypeError ? error.message : 'AL control message is malformed'
        });
    }
}

export function newALAckControlMessage(id: ALMessage['id'], payload: ALAckPayload): ALMessage {
    return newALControlMessage(id, AL_CONTROL_ACK_TYPE_ID, decodeALAckPayload(payload));
}

export function newALNackControlMessage(id: ALMessage['id'], payload: ALNackPayload): ALMessage {
    return newALControlMessage(id, AL_CONTROL_NACK_TYPE_ID, decodeALNackPayload(payload));
}

export function newALRepairControlMessage(id: ALMessage['id'], payload: ALRepairPayload): ALMessage {
    return newALControlMessage(id, AL_CONTROL_REPAIR_TYPE_ID, decodeALRepairPayload(payload));
}

function newALControlMessage(id: ALMessage['id'], typeId: string, payload: ALControlPayload): ALMessage {
    const targetMsgId = 'ackedMsgId' in payload ? payload.ackedMsgId : payload.msgId;
    const resource = JSON.stringify(payload);
    if (utf8Length(resource) > AL_MESSAGE_RESOURCE_LIMITS.payloadBytes) {
        throw new TypeError('Control payload exceeds the byte limit');
    }
    const message: ALMessage = {
        id,
        route: { topicId: 'al-control', resourceId: targetMsgId, contextId: payload.toPeerId },
        targets: { mode: 'unicast', toPeerId: payload.toPeerId },
        qos: {
            delivery: { algo: 'best-effort' },
            durability: { algo: 'volatile' },
            ack: { algo: 'none', opts: { timeoutMs: 250 } }
        },
        payload: { typeId, contentType: 'application/json', resource }
    };
    const rejection = decodeALControlMessage(message).left;
    if (rejection) {
        throw new TypeError(rejection.message);
    }
    return message;
}

function validateControlEnvelope(msg: ALMessage, payload: ALControlPayload): void {
    const targetMsgId = 'ackedMsgId' in payload ? payload.ackedMsgId : payload.msgId;
    if (payload.fromPeerId !== msg.id.senderId) {
        throw new TypeError('Control payload sender does not match its envelope identity');
    }
    if (msg.targets?.mode !== 'unicast' || payload.toPeerId !== msg.targets.toPeerId) {
        throw new TypeError('Control payload receiver does not match its unicast target');
    }
    if (
        msg.route.topicId !== 'al-control' || msg.route.resourceId !== targetMsgId ||
        msg.route.contextId !== payload.toPeerId
    ) {
        throw new TypeError('Control route does not match its payload identities');
    }
    if (msg.delivery && (msg.delivery.reliability !== 'best-effort' || msg.delivery.ack !== 'none')) {
        throw new TypeError('Control messages cannot request reliable delivery or acknowledgements');
    }
    if (
        msg.qos?.delivery?.algo !== 'best-effort' || msg.qos.durability?.algo !== 'volatile' ||
        msg.qos.ack?.algo !== 'none' || (msg.qos.retry !== undefined && msg.qos.retry.algo !== 'none')
    ) {
        throw new TypeError('Control QoS must be volatile, best effort, and acknowledgement free');
    }
}

function parseControlPayload(resource: string): unknown {
    if (utf8Length(resource) > AL_MESSAGE_RESOURCE_LIMITS.payloadBytes) {
        throw new TypeError('Control payload exceeds the byte limit');
    }
    let value: unknown;
    try {
        value = JSON.parse(resource);
    }
    catch {
        throw new TypeError('Control payload must contain valid JSON');
    }
    return value;
}

function utf8Length(value: string): number {
    return value.length > AL_MESSAGE_RESOURCE_LIMITS.payloadBytes
        ? value.length
        : new TextEncoder().encode(value).length;
}
