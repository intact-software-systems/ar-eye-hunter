import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { decodePersistedALMessageValue } from '../../al-contracts/al-message-persistence-validation.ts';
import type { ALAdmissionBackend } from '../al-admission-backend.ts';
import {
    decodeALAdmissionNumber,
    decodeALAdmissionRecord,
    decodeALAdmissionString
} from '../al-admission-value-validation.ts';

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
