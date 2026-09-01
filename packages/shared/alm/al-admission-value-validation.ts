import type {
    ALAckPayload,
    ALControlPersistenceValue,
    ALNackPayload,
    ALPendingAckSnapshot,
    ALRepairPayload
} from '../al-contracts/al-control.ts';
import {
    requirePersistedALFields,
    type PersistedALRecord,
    type PersistedALValue
} from '../al-contracts/al-message-persistence/persisted-al-value-validation.ts';
import type { ALSupersedencePersistenceValue } from '../al-contracts/al-runtime.ts';

import type { ALVersionedClientRecord } from './inbound/al-inbound-admission-store.ts';

export function decodeALAdmissionString(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError('Stored admission identifier is invalid');
    }
    return value;
}

export function decodeALAdmissionNumber(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
        throw new TypeError('Stored admission counter or timestamp is invalid');
    }
    return value;
}

export function decodeALAdmissionClientRecord(value: unknown, expectedSenderId: string): ALVersionedClientRecord {
    const record = decodeALAdmissionRecord(value, ['senderId', 'version']);
    const senderId = decodeALAdmissionString(record.senderId);
    if (senderId !== expectedSenderId) {
        throw new TypeError('Stored admission version belongs to another sender');
    }
    return { senderId, version: decodeALAdmissionNumber(record.version) };
}

export function decodeALAdmissionControlValue<K extends ALControlPersistenceValue['kind']>(
    value: unknown,
    expectedMsgId: string,
    expectedKind: K
): Extract<ALControlPersistenceValue, { kind: K; }> {
    const record = decodeALAdmissionRecord(value, expectedKind === 'pending' ? ['kind', 'value'] : ['kind', 'values']);
    if (record.kind !== expectedKind) {
        throw new TypeError('Stored admission control has the wrong kind for its slot');
    }
    let control: ALControlPersistenceValue;
    switch (record.kind) {
        case 'acks':
            control = {
                kind: 'acks',
                values: decodeALAdmissionArray(record.values, (entry) => decodeAck(entry, expectedMsgId))
            };
            break;
        case 'nacks':
            control = {
                kind: 'nacks',
                values: decodeALAdmissionArray(record.values, (entry) => decodeNack(entry, expectedMsgId))
            };
            break;
        case 'repairs':
            control = {
                kind: 'repairs',
                values: decodeALAdmissionArray(record.values, (entry) => decodeRepair(entry, expectedMsgId))
            };
            break;
        case 'pending':
            control = { kind: 'pending', value: decodePendingAck(record.value) };
            break;
        default:
            throw new TypeError('Stored admission control kind is invalid');
    }
    // Every field and the equality with K have been checked above.
    return control as Extract<ALControlPersistenceValue, { kind: K; }>;
}

export function decodeALAdmissionSupersedenceValue<K extends ALSupersedencePersistenceValue['kind']>(
    value: unknown,
    expectedKind: K
): Extract<ALSupersedencePersistenceValue, { kind: K; }> {
    const record = expectedKind === 'latest'
        ? decodeALAdmissionRecord(value, ['kind', 'latestMsgId', 'latestTs', 'updatedAtMs'], ['latestSeq'])
        : decodeALAdmissionRecord(value, ['kind', 'byMsgId', 'updatedAtMs']);
    if (record.kind !== expectedKind) {
        throw new TypeError('Stored admission supersedence has the wrong kind for its slot');
    }
    const updatedAtMs = decodeALAdmissionNumber(record.updatedAtMs);
    const supersedence: ALSupersedencePersistenceValue = record.kind === 'latest'
        ? {
            kind: 'latest',
            latestMsgId: decodeALAdmissionString(record.latestMsgId),
            latestTs: decodeALAdmissionNumber(record.latestTs),
            updatedAtMs,
            ...(record.latestSeq === undefined ? {} : { latestSeq: decodeALAdmissionNumber(record.latestSeq) })
        }
        : { kind: 'replacement', byMsgId: decodeALAdmissionString(record.byMsgId), updatedAtMs };
    return supersedence as Extract<ALSupersedencePersistenceValue, { kind: K; }>;
}

export function decodeALAdmissionRecord(
    value: unknown,
    required: readonly string[],
    optional: readonly string[] = []
): PersistedALRecord {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new TypeError('Stored admission value must be a plain record');
    }
    // This is a raw field view, not a claim that a domain record is valid.
    const record = value as PersistedALRecord;
    requirePersistedALFields(record, [...required, ...optional], required);
    return record;
}

export function decodeALAdmissionArray<V>(value: unknown, decode: (entry: unknown) => V): readonly V[] {
    if (
        !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
        Reflect.ownKeys(value).length !== value.length + 1
    ) {
        throw new TypeError('Stored admission array is invalid');
    }
    const result: V[] = [];
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            throw new TypeError('Stored admission array must contain dense data entries');
        }
        result.push(decode(descriptor.value));
    }
    return result;
}

function decodeAck(value: unknown, expectedMsgId: string): ALAckPayload {
    const record = decodeALAdmissionRecord(value, [
        'ackedMsgId',
        'fromPeerId',
        'toPeerId',
        'status',
        'observedAtEpochMs'
    ]);
    const ackedMsgId = decodeMessageId(record.ackedMsgId, expectedMsgId);
    return {
        ackedMsgId,
        fromPeerId: decodeALAdmissionString(record.fromPeerId),
        toPeerId: decodeALAdmissionString(record.toPeerId),
        status: decodeAckStatus(record.status),
        observedAtEpochMs: decodeALAdmissionNumber(record.observedAtEpochMs)
    };
}

function decodeNack(value: unknown, expectedMsgId: string): ALNackPayload {
    const record = decodeALAdmissionRecord(value, ['msgId', 'fromPeerId', 'toPeerId', 'reason', 'observedAtEpochMs'], [
        'orderingKey',
        'expectedSeq',
        'missingSeqs',
        'serverSnapshotVersion'
    ]);
    const reason = record.reason;
    if (
        reason !== 'duplicate' && reason !== 'gap' && reason !== 'expired' && reason !== 'unauthorized' &&
        reason !== 'no-route' && reason !== 'overloaded' && reason !== 'stale' && reason !== 'not-yet-in-sync'
    ) {
        throw new TypeError('Stored admission NACK reason is invalid');
    }
    return {
        ...decodeControlRoute(record, expectedMsgId),
        reason,
        ...(record.orderingKey === undefined ? {} : { orderingKey: decodeALAdmissionString(record.orderingKey) }),
        ...(record.expectedSeq === undefined ? {} : { expectedSeq: decodeALAdmissionNumber(record.expectedSeq) }),
        ...(record.missingSeqs === undefined
            ? {}
            : { missingSeqs: decodeALAdmissionArray(record.missingSeqs, decodeALAdmissionNumber) }),
        ...(record.serverSnapshotVersion === undefined ? {} : {
            serverSnapshotVersion: decodeALAdmissionNumber(record.serverSnapshotVersion)
        })
    };
}

function decodeRepair(value: unknown, expectedMsgId: string): ALRepairPayload {
    const record = decodeALAdmissionRecord(value, ['msgId', 'fromPeerId', 'toPeerId', 'reason', 'observedAtEpochMs'], [
        'orderingKey',
        'expectedSeq',
        'missingSeqs'
    ]);
    const reason = record.reason;
    if (reason !== 'missing-seq' && reason !== 'retransmit' && reason !== 'resync') {
        throw new TypeError('Stored admission repair reason is invalid');
    }
    return {
        ...decodeControlRoute(record, expectedMsgId),
        reason,
        ...(record.orderingKey === undefined ? {} : { orderingKey: decodeALAdmissionString(record.orderingKey) }),
        ...(record.expectedSeq === undefined ? {} : { expectedSeq: decodeALAdmissionNumber(record.expectedSeq) }),
        ...(record.missingSeqs === undefined
            ? {}
            : { missingSeqs: decodeALAdmissionArray(record.missingSeqs, decodeALAdmissionNumber) })
    };
}

function decodeControlRoute(
    record: PersistedALRecord,
    expectedMsgId: string
): Pick<ALNackPayload, 'msgId' | 'fromPeerId' | 'toPeerId' | 'observedAtEpochMs'> {
    return {
        msgId: decodeMessageId(record.msgId, expectedMsgId),
        fromPeerId: decodeALAdmissionString(record.fromPeerId),
        toPeerId: decodeALAdmissionString(record.toPeerId),
        observedAtEpochMs: decodeALAdmissionNumber(record.observedAtEpochMs)
    };
}

function decodeMessageId(value: PersistedALValue, expectedMsgId: string): string {
    const msgId = decodeALAdmissionString(value);
    if (msgId !== expectedMsgId) {
        throw new TypeError('Stored admission control belongs to another message');
    }
    return msgId;
}

function decodeAckStatus(value: PersistedALValue): ALAckPayload['status'] {
    if (value !== 'accepted' && value !== 'delivered' && value !== 'forwarded' && value !== 'subtree-complete') {
        throw new TypeError('Stored admission ACK status is invalid');
    }
    return value;
}

function decodePendingAck(value: PersistedALValue): ALPendingAckSnapshot {
    const record = decodeALAdmissionRecord(value, [
        'toPeerId',
        'status',
        'localReady',
        'expectedFromPeerIds',
        'ackedFromPeerIds'
    ], ['expireAtTimestamp']);
    if (typeof record.localReady !== 'boolean') {
        throw new TypeError('Stored admission pending-ACK readiness is invalid');
    }
    return {
        toPeerId: decodeALAdmissionString(record.toPeerId),
        status: decodeAckStatus(record.status),
        localReady: record.localReady,
        expectedFromPeerIds: decodeALAdmissionArray(record.expectedFromPeerIds, decodeALAdmissionString),
        ackedFromPeerIds: decodeALAdmissionArray(record.ackedFromPeerIds, decodeALAdmissionString),
        ...(record.expireAtTimestamp === undefined
            ? {}
            : { expireAtTimestamp: decodeALAdmissionNumber(record.expireAtTimestamp) })
    };
}
