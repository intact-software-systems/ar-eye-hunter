import type { ALDeliveryCarrier } from '../alm/delivery/al-delivery-lifecycle.ts';
import { toStrictAppInboxQueueKey } from '../queuebox/AppQueueIdentity.ts';
import { isKeysEqual } from '../queuebox/ResourceEntry.ts';
import { Either } from '../resilience/Either.ts';
import type { ALMessage } from './al-contract.ts';
import {
    AL_CONTROL_ACK_TYPE_ID,
    AL_CONTROL_NACK_TYPE_ID,
    AL_CONTROL_RECEIPT_TYPE_ID,
    AL_CONTROL_REPAIR_TYPE_ID,
    isALControlTypeId
} from './al-control-type-ids.ts';
import {
    decodeALAckPayload,
    decodeALNackPayload,
    decodeALReceiptPayload,
    decodeALRepairPayload
} from './al-control-value-codec.ts';
import {
    decodeALMessageValue,
    type ALMessageRejection
} from './al-message-persistence-validation.ts';
import {
    AL_MESSAGE_RESOURCE_LIMITS
} from './al-message-resource-limits.ts';

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
    /** The acknowledged message's sender, whose receipt this ACK completes. */
    readonly originPeerId: string;
    /** The recipient this ACK speaks for; a relay re-originates one ACK per recipient it confirmed. */
    readonly logicalRecipientPeerId: string;
    /**
     * The carrier the ACK travels on. The sender names the carrier it sends on; a store that records
     * the ACK stamps the carrier it arrived on.
     */
    readonly carrier: ALDeliveryCarrier;
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

/** The WS server's word to an origin: the frozen audience at admission, the aggregate at completion or timeout. */
export interface ALReceiptPayload {
    readonly msgId: string;
    readonly originPeerId: string;
    readonly expectedRecipientPeerIds: readonly string[];
    readonly confirmedRecipientPeerIds: readonly string[];
    readonly snapshotVersion: number;
    readonly phase: 'admitted' | 'complete' | 'timed-out';
    readonly observedAtEpochMs: number;
}

export type ALControlPayload = ALAckPayload | ALNackPayload | ALRepairPayload | ALReceiptPayload;

export type ALParsedControlMessage =
    | Readonly<{ type: 'ack'; payload: ALAckPayload; }>
    | Readonly<{ type: 'nack'; payload: ALNackPayload; }>
    | Readonly<{ type: 'repair'; payload: ALRepairPayload; }>
    | Readonly<{ type: 'receipt'; payload: ALReceiptPayload; }>;

/** A control one peer sends another about a message; the receipt control is the server's and travels apart. */
export type ALPeerControlMessage = Exclude<ALParsedControlMessage, Readonly<{ type: 'receipt'; }>>;

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
    /** The carrier the acknowledged data message arrived on. */
    readonly carrier: ALDeliveryCarrier;
}

export type ALControlPersistenceValue =
    | Readonly<{ kind: 'acks'; values: readonly ALAckPayload[]; }>
    | Readonly<{ kind: 'nacks'; values: readonly ALNackPayload[]; }>
    | Readonly<{ kind: 'repairs'; values: readonly ALRepairPayload[]; }>
    | Readonly<{ kind: 'pending'; value: ALPendingAckSnapshot; }>;

export function parseALControlMessage(msg: ALMessage): ALParsedControlMessage | undefined {
    switch (msg.payload.typeId) {
        case AL_CONTROL_ACK_TYPE_ID:
            return { type: 'ack', payload: decodeALAckPayload(parseControlPayload(msg.payload.resource)) };
        case AL_CONTROL_NACK_TYPE_ID:
            return { type: 'nack', payload: decodeALNackPayload(parseControlPayload(msg.payload.resource)) };
        case AL_CONTROL_REPAIR_TYPE_ID:
            return { type: 'repair', payload: decodeALRepairPayload(parseControlPayload(msg.payload.resource)) };
        case AL_CONTROL_RECEIPT_TYPE_ID:
            return { type: 'receipt', payload: decodeALReceiptPayload(parseControlPayload(msg.payload.resource)) };
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
        const issues = validateControlEnvelope(msg, parsed);
        return issues.length === 0
            ? Either.ofRight(parsed)
            : Either.ofLeft({ code: 'malformed', message: issues.join('; ') });
    }
    catch (error) {
        return Either.ofLeft({
            code: 'malformed',
            message: error instanceof TypeError ? error.message : 'AL control message is malformed'
        });
    }
}

/** A peer's control about a message it holds; the receipt control is refused here and admitted apart. */
export function decodeALPeerControlMessage(msg: ALMessage): Either<ALMessageRejection, ALPeerControlMessage> {
    const decoded = decodeALControlMessage(msg);
    if (decoded.left) {
        return Either.ofLeft(decoded.left);
    }
    const control = decoded.right!;
    return control.type === 'receipt'
        ? Either.ofLeft({ code: 'unsupported', message: 'AL receipt control is not a peer control' })
        : Either.ofRight(control);
}

export function newALAckControlMessage(id: ALMessage['id'], payload: ALAckPayload): ALMessage {
    return newALControlMessage(id, { type: 'ack', payload: decodeALAckPayload(payload) });
}

export function newALNackControlMessage(id: ALMessage['id'], payload: ALNackPayload): ALMessage {
    return newALControlMessage(id, { type: 'nack', payload: decodeALNackPayload(payload) });
}

export function newALRepairControlMessage(id: ALMessage['id'], payload: ALRepairPayload): ALMessage {
    return newALControlMessage(id, { type: 'repair', payload: decodeALRepairPayload(payload) });
}

/** The receipt's envelope sender is whoever aggregated it; the payload names only the origin it is for. */
export function newALReceiptControlMessage(id: ALMessage['id'], payload: ALReceiptPayload): ALMessage {
    return newALControlMessage(id, { type: 'receipt', payload: decodeALReceiptPayload(payload) });
}

/** The peer a control is addressed to: the payload's receiver, or a receipt's origin. */
export function toALControlRecipientPeerId(control: ALParsedControlMessage): string {
    return toALControlAddress(control).toPeerId;
}

/** Advisory NACKs may be unrepresentable even when their referenced envelope was valid. */
export function prepareALNackControlMessage(
    id: ALMessage['id'],
    payload: ALNackPayload
): Either<ALMessageRejection, ALMessage> {
    if (
        typeof payload.toPeerId === 'string' && payload.toPeerId.length > AL_MESSAGE_RESOURCE_LIMITS.routeIdCharacters
    ) {
        return Either.ofLeft({ code: 'oversized', message: 'Control receiver exceeds the character limit' });
    }
    if (utf8Length(JSON.stringify(payload)) > AL_MESSAGE_RESOURCE_LIMITS.payloadBytes) {
        return Either.ofLeft({ code: 'oversized', message: 'Control payload exceeds the byte limit' });
    }
    const control: ALParsedControlMessage = { type: 'nack', payload: decodeALNackPayload(payload) };
    const message = computeALControlMessage({ id, control, resource: JSON.stringify(control.payload) });
    const rejection = decodeALControlMessage(message).left;
    if (rejection?.code === 'oversized') {
        return Either.ofLeft(rejection);
    }
    if (rejection) {
        throw new TypeError(rejection.message);
    }
    return Either.ofRight(message);
}

function newALControlMessage(id: ALMessage['id'], control: ALParsedControlMessage): ALMessage {
    const resource = JSON.stringify(control.payload);
    if (utf8Length(resource) > AL_MESSAGE_RESOURCE_LIMITS.payloadBytes) {
        throw new TypeError('Control payload exceeds the byte limit');
    }
    const message = computeALControlMessage({ id, control, resource });
    const rejection = decodeALControlMessage(message).left;
    if (rejection) {
        throw new TypeError(rejection.message);
    }
    return message;
}

interface ALControlMessageInput {
    readonly id: ALMessage['id'];
    readonly control: ALParsedControlMessage;
    readonly resource: string;
}

interface ALControlAddress {
    readonly referencedMsgId: string;
    /** The sender the payload names; a receipt names none, since its aggregating server stays anonymous. */
    readonly senderPeerId: string | undefined;
    readonly toPeerId: string;
}

const AL_CONTROL_TYPE_IDS: Readonly<Record<ALParsedControlMessage['type'], string>> = {
    ack: AL_CONTROL_ACK_TYPE_ID,
    nack: AL_CONTROL_NACK_TYPE_ID,
    repair: AL_CONTROL_REPAIR_TYPE_ID,
    receipt: AL_CONTROL_RECEIPT_TYPE_ID
};

function computeALControlMessage(input: ALControlMessageInput): ALMessage {
    const address = toALControlAddress(input.control);
    return {
        id: input.id,
        route: toALControlRoute(address),
        targets: { mode: 'unicast', toPeerId: address.toPeerId },
        qos: {
            delivery: { algo: 'best-effort' },
            durability: { algo: 'volatile' },
            ack: { algo: 'none', opts: { timeoutMs: 250 } }
        },
        payload: {
            typeId: AL_CONTROL_TYPE_IDS[input.control.type],
            contentType: 'application/json',
            resource: input.resource
        }
    };
}

function toALControlAddress(control: ALParsedControlMessage): ALControlAddress {
    switch (control.type) {
        case 'ack':
            return {
                referencedMsgId: control.payload.ackedMsgId,
                senderPeerId: control.payload.fromPeerId,
                toPeerId: control.payload.toPeerId
            };
        case 'nack':
        case 'repair':
            return {
                referencedMsgId: control.payload.msgId,
                senderPeerId: control.payload.fromPeerId,
                toPeerId: control.payload.toPeerId
            };
        case 'receipt':
            return {
                referencedMsgId: control.payload.msgId,
                senderPeerId: undefined,
                toPeerId: control.payload.originPeerId
            };
    }
}

function validateControlEnvelope(msg: ALMessage, control: ALParsedControlMessage): readonly string[] {
    const address = toALControlAddress(control);
    const issues: string[] = [];
    if (address.senderPeerId !== undefined && address.senderPeerId !== msg.id.senderId) {
        issues.push('Control payload sender does not match its envelope identity');
    }
    if (msg.targets?.mode !== 'unicast' || address.toPeerId !== msg.targets.toPeerId) {
        issues.push('Control payload receiver does not match its unicast target');
    }
    if (!isKeysEqual(msg.route, toALControlRoute(address))) {
        issues.push('Control route does not match its payload identities');
    }
    if (msg.delivery && (msg.delivery.reliability !== 'best-effort' || msg.delivery.ack !== 'none')) {
        issues.push('Control messages cannot request reliable delivery or acknowledgements');
    }
    if (
        msg.qos?.delivery?.algo !== 'best-effort' || msg.qos.durability?.algo !== 'volatile' ||
        msg.qos.ack?.algo !== 'none' || (msg.qos.retry !== undefined && msg.qos.retry.algo !== 'none')
    ) {
        issues.push('Control QoS must be volatile, best effort, and acknowledgement free');
    }
    return issues;
}

function toALControlRoute(address: ALControlAddress): ALMessage['route'] {
    // The bounded locator routes a control; authorization compares its full payload identities.
    return toStrictAppInboxQueueKey({
        topicId: 'al-control',
        resourceId: address.referencedMsgId,
        contextId: address.toPeerId
    });
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
