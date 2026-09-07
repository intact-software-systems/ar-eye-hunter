import {
    decodeALAdmissionArray,
    decodeALAdmissionRecord,
    decodeALAdmissionString
} from '../al-admission-value-validation.ts';
import type { ALInboundControlOwnerIndex, ALInboundMessageOwner } from './al-inbound-admission-store.ts';
import type { ALInboundMessageRuntime } from './al-inbound-message-runtime.ts';

export const AL_INBOUND_PROVENANCE_LIMITS = {
    /** Bounds one durable provenance row without imposing the AL wire collection limit on a room audience. */
    frozenAudienceBytes: 1024 * 1024
} as const;

export function decodeALInboundSource(value: unknown): ALInboundMessageRuntime.Source {
    const source = decodeALAdmissionRecord(value, ['kind'], ['peerId', 'roomRecipientPeerIds']);
    if (
        source.kind === 'trusted-server' && source.peerId === undefined &&
        source.roomRecipientPeerIds === undefined
    ) {
        return { kind: 'trusted-server' };
    }
    if (source.kind === 'ws-client') {
        return {
            kind: 'ws-client',
            peerId: decodeALAdmissionString(source.peerId),
            ...(source.roomRecipientPeerIds === undefined
                ? {}
                : { roomRecipientPeerIds: decodeFrozenRoomAudience(source.roomRecipientPeerIds) })
        };
    }
    if (source.kind === 'rtc-peer' && source.roomRecipientPeerIds === undefined) {
        return { kind: source.kind, peerId: decodeALAdmissionString(source.peerId) };
    }
    throw new TypeError('Persisted AL ingress source is invalid');
}

function decodeFrozenRoomAudience(value: unknown): readonly string[] {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError('Stored frozen room audience must be a plain array');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1) {
        throw new TypeError('Stored frozen room audience must contain dense data entries');
    }
    const encoder = new TextEncoder();
    const audience: string[] = [];
    let bytes = 2;
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            throw new TypeError('Stored frozen room audience must contain dense data entries');
        }
        const peerId = decodeALAdmissionString(descriptor.value);
        bytes += encoder.encode(JSON.stringify(peerId)).length + (index === 0 ? 0 : 1);
        if (bytes > AL_INBOUND_PROVENANCE_LIMITS.frozenAudienceBytes) {
            throw new TypeError('Stored frozen room audience exceeds the provenance byte limit');
        }
        audience.push(peerId);
    }
    return audience;
}

export interface ALInboundMessageOwnerSlot {
    readonly namespace: string;
    readonly key: string;
    readonly expectedMsgId: string;
    readonly expectedSenderId: string;
}

export function toALInboundMessageOwnerKey(namespace: string, msgId: string, senderId: string): string {
    return `${namespace}:msg-owner:${encodeURIComponent(msgId)}:${encodeURIComponent(senderId)}`;
}

export function decodeALInboundMessageOwner(value: unknown, slot: ALInboundMessageOwnerSlot): ALInboundMessageOwner {
    const owner = decodeALAdmissionRecord(value, ['msgId', 'senderId', 'source', 'supersedenceKey']);
    const msgId = decodeALAdmissionString(owner.msgId);
    const senderId = decodeALAdmissionString(owner.senderId);
    if (
        msgId !== slot.expectedMsgId || senderId !== slot.expectedSenderId ||
        slot.key !== toALInboundMessageOwnerKey(slot.namespace, msgId, senderId)
    ) {
        throw new TypeError('Stored inbound message owner identity does not match its slot');
    }
    if (owner.supersedenceKey !== null && typeof owner.supersedenceKey !== 'string') {
        throw new TypeError('Stored inbound message owner supersedence key is invalid');
    }
    return {
        msgId,
        senderId,
        source: decodeALInboundSource(owner.source),
        supersedenceKey: owner.supersedenceKey
    };
}

export function decodeALInboundControlOwnerIndex(value: unknown): ALInboundControlOwnerIndex {
    const record = decodeALAdmissionRecord(value, ['ambiguous', 'values']);
    if (typeof record.ambiguous !== 'boolean') {
        throw new TypeError('Stored inbound control owner ambiguity is invalid');
    }
    const peerIds = new Set<string>();
    const values = decodeALAdmissionArray(record.values, (entry) => {
        const owner = decodeALAdmissionRecord(entry, ['peerId', 'senderId']);
        const peerId = decodeALAdmissionString(owner.peerId);
        if (
            peerId.length === 0 || peerIds.has(peerId) ||
            (owner.senderId !== null && (typeof owner.senderId !== 'string' || owner.senderId.length === 0))
        ) {
            throw new TypeError('Stored inbound control owner entry is invalid');
        }
        peerIds.add(peerId);
        return {
            peerId,
            senderId: owner.senderId
        };
    });
    if (record.ambiguous && values.length !== 0) {
        throw new TypeError('Ambiguous inbound control owner index must not retain entries');
    }
    return { ambiguous: record.ambiguous, values };
}
