import {
    decodeALAdmissionRecord,
    decodeALAdmissionString
} from '../al-admission-value-validation.ts';
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
