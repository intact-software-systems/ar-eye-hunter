import {
    decodeALAckPayload,
    decodeALNackPayload,
    decodeALPendingAckSnapshot,
    decodeALRepairPayload
} from '../al-contracts/al-control-value-codec.ts';
import {
    type ALControlPayload,
    type ALControlPersistenceValue
} from '../al-contracts/al-control.ts';
import {
    requirePersistedALFields,
    type PersistedALRecord
} from '../al-contracts/al-message-persistence/persisted-al-value-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../al-contracts/al-message-resource-limits.ts';
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
                values: decodeALAdmissionArray(
                    record.values,
                    (entry) => requireExpectedControlMessage(decodeALAckPayload(entry), expectedMsgId)
                )
            };
            break;
        case 'nacks':
            control = {
                kind: 'nacks',
                values: decodeALAdmissionArray(
                    record.values,
                    (entry) => requireExpectedControlMessage(decodeALNackPayload(entry), expectedMsgId)
                )
            };
            break;
        case 'repairs':
            control = {
                kind: 'repairs',
                values: decodeALAdmissionArray(
                    record.values,
                    (entry) => requireExpectedControlMessage(decodeALRepairPayload(entry), expectedMsgId)
                )
            };
            break;
        case 'pending':
            control = { kind: 'pending', value: decodeALPendingAckSnapshot(record.value) };
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
        value.length > AL_MESSAGE_RESOURCE_LIMITS.collectionEntries ||
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

function requireExpectedControlMessage<T extends ALControlPayload>(payload: T, expectedMsgId: string): T {
    const msgId = 'ackedMsgId' in payload ? payload.ackedMsgId : payload.msgId;
    if (msgId !== expectedMsgId) {
        throw new TypeError('Stored admission control belongs to another message');
    }
    return payload;
}
