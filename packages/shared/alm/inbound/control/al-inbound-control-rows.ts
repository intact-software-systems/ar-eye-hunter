import type { ALAckPayload, ALControlPersistenceValue } from '../../../al-contracts/al-control.ts';
import type { ALAdmissionBackend, ALAdmissionWriteContext } from '../../al-admission-backend.ts';
import { decodeALAdmissionControlValue } from '../../al-admission-value-validation.ts';
import type {
    ALInboundAdmissionMutation,
    ALInboundAdmissionObservations,
    ALInboundControlDecisionSurface,
    ALInboundControlOwnerIndex
} from '../al-inbound-admission-store.ts';
import {
    decodeALInboundControlOwnerIndex,
    readALInboundMessageOwner,
    type ALInboundMessageRowsRead
} from '../al-inbound-source-validation.ts';

export type PendingControlValue = Extract<ALControlPersistenceValue, Readonly<{ kind: 'pending'; }>>;
export type AcksControlValue = Extract<ALControlPersistenceValue, Readonly<{ kind: 'acks'; }>>;

export type ALInboundControlMutation = Extract<
    ALInboundAdmissionMutation,
    { kind: 'set-control-acks' | 'set-control-pending' | 'delete-control-pending' | 'set-control-owners'; }
>;

/** The acknowledgement rows one message owns, under the namespace the store was opened with. */
export function toALInboundControlAcksKey(namespace: string, msgId: string, senderId: string): string {
    return `${namespace}:control:acks:${encodeURIComponent(msgId)}:${encodeURIComponent(senderId)}`;
}

export function toALInboundControlPendingKey(namespace: string, msgId: string, senderId: string): string {
    return `${namespace}:control:pending:${encodeURIComponent(msgId)}:${encodeURIComponent(senderId)}`;
}

export function toALInboundControlOwnersKey(namespace: string, msgId: string): string {
    return `${namespace}:control:owners:${encodeURIComponent(msgId)}`;
}

export async function readStoredAcknowledgements(
    read: ALInboundMessageRowsRead
): Promise<Pick<ALInboundAdmissionObservations, 'pendingAck' | 'acks'>> {
    const { database, namespace, msgId, senderId } = read;
    const pendingAck = (await database.read(
        toALInboundControlPendingKey(namespace, msgId, senderId),
        (value) => decodeALAdmissionControlValue(value, msgId, 'pending')
    ))?.value;
    const acks = (await database.read(
        toALInboundControlAcksKey(namespace, msgId, senderId),
        (value) => decodeALAdmissionControlValue(value, msgId, 'acks')
    ))?.values ?? [];
    return { pendingAck, acks };
}

export async function readStoredControlOwnerIndex(
    database: Pick<ALAdmissionBackend, 'read'>,
    namespace: string,
    msgId: string
): Promise<ALInboundControlOwnerIndex | undefined> {
    return await database.read(toALInboundControlOwnersKey(namespace, msgId), decodeALInboundControlOwnerIndex);
}

/** Absent when the owner index names no single original sender for the acknowledging peer. */
export async function readControlDecisionSurface(
    database: Pick<ALAdmissionBackend, 'read'>,
    namespace: string,
    ack: ALAckPayload
): Promise<ALInboundControlDecisionSurface | undefined> {
    const controlOwners = await readStoredControlOwnerIndex(database, namespace, ack.ackedMsgId);
    if (controlOwners === undefined) {
        return undefined;
    }
    const senderId = resolveALInboundAcknowledgedSenderId(controlOwners, ack.fromPeerId);
    if (senderId === undefined) {
        return undefined;
    }
    const rows: ALInboundMessageRowsRead = { database, namespace, msgId: ack.ackedMsgId, senderId };
    const messageOwner = await readALInboundMessageOwner(rows);
    const { pendingAck, acks } = await readStoredAcknowledgements(rows);
    return { senderId, controlOwners, messageOwner, pendingAck, acks };
}

/**
 * Which original sender an acknowledging peer is tracked under. An overflowed index retains no
 * entries, and a peer that could acknowledge same-ID messages from several senders names none, so
 * both resolve to no sender at all and leave the rest of the surface unread.
 */
export function resolveALInboundAcknowledgedSenderId(
    controlOwners: ALInboundControlOwnerIndex,
    fromPeerId: string
): string | undefined {
    if (controlOwners.ambiguous) {
        return undefined;
    }
    return controlOwners.values.find((value) => value.peerId === fromPeerId)?.senderId ?? undefined;
}

export async function applyALInboundControlMutation(
    transaction: ALAdmissionWriteContext,
    namespace: string,
    mutation: ALInboundControlMutation
): Promise<void> {
    switch (mutation.kind) {
        case 'set-control-acks':
            return await transaction.set(
                toALInboundControlAcksKey(namespace, mutation.msgId, mutation.senderId),
                mutation.value,
                mutation.expireAtTimestamp
            );
        case 'set-control-pending':
            return await transaction.set(
                toALInboundControlPendingKey(namespace, mutation.msgId, mutation.senderId),
                mutation.value,
                mutation.expireAtTimestamp
            );
        case 'delete-control-pending':
            return await transaction.remove(toALInboundControlPendingKey(namespace, mutation.msgId, mutation.senderId));
        case 'set-control-owners':
            return await transaction.set(
                toALInboundControlOwnersKey(namespace, mutation.msgId),
                mutation.value,
                mutation.expireAtTimestamp
            );
    }
}
