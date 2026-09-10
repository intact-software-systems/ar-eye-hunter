import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { decodePersistedALMessageValue } from '../../al-contracts/al-message-persistence-validation.ts';
import type { ALAdmissionBackend } from '../al-admission-backend.ts';
import {
    decodeALAdmissionArray,
    decodeALAdmissionNumber,
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
    const source = decodeALAdmissionRecord(value, ['kind'], ['peerId', 'groupRecipientPeerIds']);
    if (
        source.kind === 'trusted-server' && source.peerId === undefined &&
        source.groupRecipientPeerIds === undefined
    ) {
        return { kind: 'trusted-server' };
    }
    if (source.kind === 'ws-client') {
        return {
            kind: 'ws-client',
            peerId: decodeALAdmissionString(source.peerId),
            ...(source.groupRecipientPeerIds === undefined
                ? {}
                : { groupRecipientPeerIds: decodeFrozenGroupAudience(source.groupRecipientPeerIds) })
        };
    }
    if (source.kind === 'rtc-peer' && source.groupRecipientPeerIds === undefined) {
        return { kind: source.kind, peerId: decodeALAdmissionString(source.peerId) };
    }
    throw new TypeError('Persisted AL ingress source is invalid');
}

function decodeFrozenGroupAudience(value: unknown): readonly string[] {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError('Stored frozen group audience must be a plain array');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1) {
        throw new TypeError('Stored frozen group audience must contain dense data entries');
    }
    const encoder = new TextEncoder();
    const audience: string[] = [];
    let bytes = 2;
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            throw new TypeError('Stored frozen group audience must contain dense data entries');
        }
        const peerId = decodeALAdmissionString(descriptor.value);
        bytes += encoder.encode(JSON.stringify(peerId)).length + (index === 0 ? 0 : 1);
        if (bytes > AL_INBOUND_PROVENANCE_LIMITS.frozenAudienceBytes) {
            throw new TypeError('Stored frozen group audience exceeds the provenance byte limit');
        }
        audience.push(peerId);
    }
    return audience;
}

export interface ALInboundMessageReference {
    readonly senderId: string;
    readonly msgId: string;
}

export interface ALStoredInboundMessage {
    readonly msgId: string;
    readonly senderId: string;
    readonly msg: ALMessage;
    /** The row's own persistence expiry, so a slot that names it can never be retained past it. */
    readonly retainUntilMs: number;
}

export interface ALStoredInboundMessageSlot {
    readonly namespace: string;
    readonly key: string;
    readonly reference: ALInboundMessageReference;
}

export function toALInboundMessageReference(msg: ALMessage): ALInboundMessageReference {
    return { senderId: msg.id.senderId, msgId: msg.id.msgId };
}

export function toALInboundMessageKey(namespace: string, reference: ALInboundMessageReference): string {
    return `${namespace}:message:${encodeURIComponent(reference.senderId)}:${encodeURIComponent(reference.msgId)}`;
}

export function decodeALInboundMessageReference(value: unknown): ALInboundMessageReference {
    const reference = decodeALAdmissionRecord(value, ['senderId', 'msgId']);
    return {
        senderId: decodeALAdmissionString(reference.senderId),
        msgId: decodeALAdmissionString(reference.msgId)
    };
}

export interface ReadALInboundStoredMessageInput {
    readonly database: Pick<ALAdmissionBackend, 'read'>;
    readonly namespace: string;
    readonly reference: ALInboundMessageReference;
}

export async function readALInboundStoredMessage(
    input: ReadALInboundStoredMessageInput
): Promise<ALStoredInboundMessage | undefined> {
    const { database, namespace, reference } = input;
    return await database.read(
        toALInboundMessageKey(namespace, reference),
        (value, key) => decodeALStoredInboundMessage(value, { key, namespace, reference })
    );
}

export function decodeALStoredInboundMessage(
    value: unknown,
    slot: ALStoredInboundMessageSlot
): ALStoredInboundMessage {
    const stored = decodeALAdmissionRecord(value, ['msgId', 'senderId', 'msg', 'retainUntilMs']);
    const msgId = decodeALAdmissionString(stored.msgId);
    const senderId = decodeALAdmissionString(stored.senderId);
    const msg = decodePersistedALMessageValue(stored.msg);
    const retainUntilMs = decodeALAdmissionNumber(stored.retainUntilMs);
    if (
        msgId !== slot.reference.msgId || senderId !== slot.reference.senderId ||
        msg.id.msgId !== msgId || msg.id.senderId !== senderId ||
        slot.key !== toALInboundMessageKey(slot.namespace, { senderId, msgId })
    ) {
        throw new TypeError('Stored inbound message identity does not match its slot');
    }
    return { msgId, senderId, msg, retainUntilMs };
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
