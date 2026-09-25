import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { resolveALFrozenMulticastAudience } from '../../al-contracts/al-frozen-multicast-audience.ts';
import type { PersistedALRecord } from '../../al-contracts/al-message-persistence/persisted-al-value-validation.ts';
import type { ALAdmissionBackend } from '../al-admission-backend.ts';
import {
    decodeALAdmissionArray,
    decodeALAdmissionNumber,
    decodeALAdmissionRecord,
    decodeALAdmissionString
} from '../al-admission-value-validation.ts';
import type { ALDeliveryCarrier } from '../delivery/al-delivery-lifecycle.ts';
import type { ALInboundControlOwnerIndex, ALInboundMessageOwner } from './al-inbound-admission-store.ts';
import type { ALInboundMessageRuntime } from './al-inbound-message-runtime.ts';

export const AL_INBOUND_PROVENANCE_LIMITS = {
    /** Bounds one durable provenance row without imposing the AL wire collection limit on a room audience. */
    frozenAudienceBytes: 1024 * 1024
} as const;

/** The carrier an admitted source arrived on, and so the runtime whose work rows it owns. */
export function toALDeliveryCarrier(source: ALInboundMessageRuntime.Source): ALDeliveryCarrier {
    switch (source.kind) {
        case 'rtc-peer':
            return 'rtc';
        case 'ws-client':
        case 'trusted-server':
            return 'ws';
    }
}

/** An RTC arrival's provenance: a room multicast copy carries the audience its origin froze, and its version. */
export function toALRtcPeerSource(peerId: string, message: ALMessage | undefined): ALInboundMessageRuntime.Source {
    const frozen = resolveALFrozenMulticastAudience(message?.targets);
    return frozen === undefined
        ? { kind: 'rtc-peer', peerId }
        : {
            kind: 'rtc-peer',
            peerId,
            groupRecipientPeerIds: frozen.recipientPeerIds,
            snapshotVersion: frozen.snapshotVersion
        };
}

export function decodeALInboundSource(value: unknown): ALInboundMessageRuntime.Source {
    const source = decodeALAdmissionRecord(value, ['kind'], ['peerId', 'groupRecipientPeerIds', 'snapshotVersion']);
    if (
        source.kind === 'trusted-server' && source.peerId === undefined &&
        source.groupRecipientPeerIds === undefined && source.snapshotVersion === undefined
    ) {
        return { kind: 'trusted-server' };
    }
    if (source.kind === 'ws-client' && source.snapshotVersion === undefined) {
        return {
            kind: 'ws-client',
            peerId: decodeALAdmissionString(source.peerId),
            ...(source.groupRecipientPeerIds === undefined
                ? {}
                : { groupRecipientPeerIds: decodeFrozenGroupAudience(source.groupRecipientPeerIds) })
        };
    }
    if (source.kind === 'rtc-peer') {
        return decodeRtcPeerSource(source);
    }
    throw new TypeError('Persisted AL ingress source is invalid');
}

/** An RTC copy of a room multicast carries its frozen audience and that audience's snapshot version together. */
function decodeRtcPeerSource(source: PersistedALRecord): ALInboundMessageRuntime.Source {
    const peerId = decodeALAdmissionString(source.peerId);
    if (source.groupRecipientPeerIds === undefined && source.snapshotVersion === undefined) {
        return { kind: 'rtc-peer', peerId };
    }
    return {
        kind: 'rtc-peer',
        peerId,
        groupRecipientPeerIds: decodeFrozenGroupAudience(source.groupRecipientPeerIds),
        snapshotVersion: decodeFrozenSnapshotVersion(source.snapshotVersion)
    };
}

function decodeFrozenSnapshotVersion(value: unknown): number {
    const snapshotVersion = decodeALAdmissionNumber(value);
    if (snapshotVersion < 1) {
        throw new TypeError('Stored frozen group audience snapshot version is invalid');
    }
    return snapshotVersion;
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

export interface ALInboundMessageOwnerSlot {
    readonly namespace: string;
    readonly key: string;
    readonly expectedMsgId: string;
    readonly expectedSenderId: string;
}

export function toALInboundMessageOwnerKey(namespace: string, msgId: string, senderId: string): string {
    return `${namespace}:msg-owner:${encodeURIComponent(msgId)}:${encodeURIComponent(senderId)}`;
}

/** One message's rows under the original sender they are tracked for, read from one session. */
export interface ALInboundMessageRowsRead {
    readonly database: Pick<ALAdmissionBackend, 'read'>;
    readonly namespace: string;
    readonly msgId: string;
    readonly senderId: string;
}

export async function readALInboundMessageOwner(
    read: ALInboundMessageRowsRead
): Promise<ALInboundMessageOwner | undefined> {
    const { namespace, msgId, senderId } = read;
    return await read.database.read(
        toALInboundMessageOwnerKey(namespace, msgId, senderId),
        (value, key) =>
            decodeALInboundMessageOwner(value, { key, namespace, expectedMsgId: msgId, expectedSenderId: senderId })
    );
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
