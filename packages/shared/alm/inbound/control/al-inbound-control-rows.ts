import type { ALControlPersistenceValue } from '../../../al-contracts/al-control.ts';
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
export type NacksControlValue = Extract<ALControlPersistenceValue, Readonly<{ kind: 'nacks'; }>>;

export type ALInboundControlMutation = Extract<
    ALInboundAdmissionMutation,
    { kind: 'set-control-acks' | 'set-control-nacks' | 'set-control-pending' | 'set-control-owners'; }
>;

/** The acknowledgement rows one message owns, under the namespace the store was opened with. */
export function toALInboundControlAcksKey(namespace: string, msgId: string, senderId: string): string {
    return `${namespace}:control:acks:${encodeURIComponent(msgId)}:${encodeURIComponent(senderId)}`;
}

/** The outside-audience NACKs a relay admitted from its children, which it forwards again on a retried copy. */
export function toALInboundControlNacksKey(namespace: string, msgId: string, senderId: string): string {
    return `${namespace}:control:nacks:${encodeURIComponent(msgId)}:${encodeURIComponent(senderId)}`;
}

export function toALInboundControlPendingKey(namespace: string, msgId: string, senderId: string): string {
    return `${namespace}:control:pending:${encodeURIComponent(msgId)}:${encodeURIComponent(senderId)}`;
}

export function toALInboundControlOwnersKey(namespace: string, msgId: string): string {
    return `${namespace}:control:owners:${encodeURIComponent(msgId)}`;
}

export async function readStoredAcknowledgements(
    read: ALInboundMessageRowsRead
): Promise<Pick<ALInboundAdmissionObservations, 'pendingAck' | 'acks' | 'nacks'>> {
    const { database, namespace, msgId, senderId } = read;
    const pendingAck = (await database.read(
        toALInboundControlPendingKey(namespace, msgId, senderId),
        (value) => decodeALAdmissionControlValue(value, msgId, 'pending')
    ))?.value;
    const acks = (await database.read(
        toALInboundControlAcksKey(namespace, msgId, senderId),
        (value) => decodeALAdmissionControlValue(value, msgId, 'acks')
    ))?.values ?? [];
    // Only a relay row's admission writes a NACK history, so a message without one costs no read of it.
    const nacks = pendingAck === undefined ? [] : (await database.read(
        toALInboundControlNacksKey(namespace, msgId, senderId),
        (value) => decodeALAdmissionControlValue(value, msgId, 'nacks')
    ))?.values ?? [];
    return { pendingAck, acks, nacks };
}

export async function readStoredControlOwnerIndex(
    database: Pick<ALAdmissionBackend, 'read'>,
    namespace: string,
    msgId: string
): Promise<ALInboundControlOwnerIndex | undefined> {
    return await database.read(toALInboundControlOwnersKey(namespace, msgId), decodeALInboundControlOwnerIndex);
}

/** Which message a child's control is about, and the child hop it came from. */
export interface ALInboundControlSubject {
    readonly msgId: string;
    readonly fromPeerId: string;
}

/** Absent when the owner index names no single original sender for the controlling peer. */
export async function readControlDecisionSurface(
    database: Pick<ALAdmissionBackend, 'read'>,
    namespace: string,
    subject: ALInboundControlSubject
): Promise<ALInboundControlDecisionSurface | undefined> {
    const controlOwners = await readStoredControlOwnerIndex(database, namespace, subject.msgId);
    if (controlOwners === undefined) {
        return undefined;
    }
    const senderId = resolveALInboundAcknowledgedSenderId(controlOwners, subject.fromPeerId);
    if (senderId === undefined) {
        return undefined;
    }
    const rows: ALInboundMessageRowsRead = { database, namespace, msgId: subject.msgId, senderId };
    const messageOwner = await readALInboundMessageOwner(rows);
    const { pendingAck, acks, nacks } = await readStoredAcknowledgements(rows);
    return { senderId, controlOwners, messageOwner, pendingAck, acks, nacks };
}

/**
 * Which original sender an acknowledging peer is tracked under. An overflowed index retains no
 * entries, and a peer that could acknowledge same-ID messages from several senders names none, so
 * both resolve to no sender at all and leave the rest of the surface unread.
 */
function resolveALInboundAcknowledgedSenderId(
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
        case 'set-control-nacks':
            return await transaction.set(
                toALInboundControlNacksKey(namespace, mutation.msgId, mutation.senderId),
                mutation.value,
                mutation.expireAtTimestamp
            );
        case 'set-control-pending':
            return await transaction.set(
                toALInboundControlPendingKey(namespace, mutation.msgId, mutation.senderId),
                mutation.value,
                mutation.expireAtTimestamp
            );
        case 'set-control-owners':
            return await transaction.set(
                toALInboundControlOwnersKey(namespace, mutation.msgId),
                mutation.value,
                mutation.expireAtTimestamp
            );
    }
}
