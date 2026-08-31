import type { ALMessage } from '../../al-contracts/al-contract.ts';
import {
    decodePersistedALMessage,
    decodePersistedALMessageValue
} from '../../al-contracts/al-message-persistence-validation.ts';
import {
    requireOptionalPersistedALNonEmptyString,
    requireOptionalPersistedALSafeInteger,
    requireOptionalPersistedALStringArray,
    requirePersistedALNonEmptyString,
    requirePersistedALSafeInteger
} from '../../al-contracts/al-message-persistence/persisted-al-value-validation.ts';
import { jsonEquals } from '../../repository/state-utils.ts';
import {
    decodeALAdmissionResourceEntry,
    encodeALAdmissionResourceEntry,
    type StoredALAdmissionResourceEntry
} from '../al-admission-resource-entry-validation.ts';
import {
    decodeALAdmissionArray,
    decodeALAdmissionNumber,
    decodeALAdmissionRecord
} from '../al-admission-value-validation.ts';
import type {
    ALOutboundDurableEffect,
    ALOutboundPreparedMessageDecoder,
    ALOutboundRepairHint,
    ALPersistedOutboundEffect
} from './al-outbound-admission-store.ts';

type StoredALOutboundDurableEffect<TPrepared> =
    | Readonly<{
        kind: 'enqueue-outbox';
        msg: ALMessage;
        entry: StoredALAdmissionResourceEntry;
        replaceExisting: boolean;
    }>
    | Readonly<{
        kind: 'fallback-dispatch';
        msg: ALMessage;
        entry: StoredALAdmissionResourceEntry;
    }>
    | Exclude<ALOutboundDurableEffect<TPrepared>, { kind: 'enqueue-outbox' | 'fallback-dispatch'; }>;

export interface StoredALPersistedOutboundEffect<TPrepared>
    extends Omit<ALPersistedOutboundEffect<TPrepared>, 'payload'> {
    readonly payload: StoredALOutboundDurableEffect<TPrepared>;
}

export function encodeALOutboundEffect<TPrepared>(
    effect: ALPersistedOutboundEffect<TPrepared>
): StoredALPersistedOutboundEffect<TPrepared> {
    const payload = effect.payload;
    switch (payload.kind) {
        case 'enqueue-outbox':
        case 'fallback-dispatch':
            return { ...effect, payload: { ...payload, entry: encodeALAdmissionResourceEntry(payload.entry) } };
        default:
            return { ...effect, payload };
    }
}

export function decodeALOutboundEffect<TPrepared>(
    value: unknown,
    expectedEffectId: string,
    decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
): ALPersistedOutboundEffect<TPrepared> {
    const effect = decodeALAdmissionRecord(value, [
        'effectId',
        'payload',
        'status',
        'attempts',
        'retryAtMs',
        'updatedAtMs',
        'expireAtTimestamp'
    ], ['leaseOwner', 'leaseUntilMs', 'lastError']);
    requirePersistedALNonEmptyString(effect.effectId, 'outbound effect id');
    if (effect.effectId !== expectedEffectId) {
        throw new TypeError('Persisted AL outbound effect identity does not match its slot');
    }
    if (effect.status !== 'pending' && effect.status !== 'running') {
        throw new TypeError('Persisted AL outbound effect status is invalid');
    }
    requirePersistedALSafeInteger(effect.attempts, 0, 'outbound effect attempts');
    requirePersistedALSafeInteger(effect.retryAtMs, 0, 'outbound effect retry time');
    requirePersistedALSafeInteger(effect.updatedAtMs, 0, 'outbound effect update time');
    requirePersistedALSafeInteger(effect.expireAtTimestamp, 0, 'outbound effect expiry');
    requireOptionalPersistedALNonEmptyString(effect.leaseOwner, 'outbound effect lease owner');
    requireOptionalPersistedALSafeInteger(effect.leaseUntilMs, 0, 'outbound effect lease expiry');
    if (effect.lastError !== undefined && typeof effect.lastError !== 'string') {
        throw new TypeError('Persisted AL outbound effect error is invalid');
    }
    if (effect.status === 'running' && (effect.leaseOwner === undefined || effect.leaseUntilMs === undefined)) {
        throw new TypeError('Persisted AL running outbound effect has no complete lease');
    }
    if (effect.status === 'pending' && (effect.leaseOwner !== undefined || effect.leaseUntilMs !== undefined)) {
        throw new TypeError('Persisted AL pending outbound effect retains a lease');
    }
    const payload = decodeALOutboundEffectPayload(effect.payload, decodePrepared);
    return { ...effect, payload } as ALPersistedOutboundEffect<TPrepared>;
}

export function decodeALOutboundPreparedMessage(value: unknown, msg: ALMessage): ALMessage {
    const prepared = decodePersistedALMessageValue(value);
    if (
        !jsonEquals(prepared.id, msg.id) || !jsonEquals(prepared.route, msg.route) ||
        !jsonEquals(prepared.targets, msg.targets) || !jsonEquals(prepared.payload, msg.payload)
    ) {
        throw new TypeError('Persisted AL prepared message does not match its outbound message');
    }
    return prepared;
}

function decodeALOutboundEffectPayload<TPrepared>(
    value: unknown,
    decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
): ALOutboundDurableEffect<TPrepared> {
    const payload = decodeALAdmissionRecord(value, ['kind'], [
        'msg',
        'prepared',
        'phase',
        'entry',
        'replaceExisting',
        'msgId',
        'request',
        'reason'
    ]);
    switch (payload.kind) {
        case 'send-prepared': {
            decodeALAdmissionRecord(value, ['kind', 'msg', 'prepared', 'phase']);
            const msg = decodePersistedALMessageValue(payload.msg);
            if (payload.phase !== 'immediate' && payload.phase !== 'dequeue') {
                throw new TypeError('Persisted AL outbound send phase is invalid');
            }
            return {
                kind: 'send-prepared',
                msg,
                prepared: decodePrepared(payload.prepared, msg),
                phase: payload.phase
            };
        }
        case 'enqueue-outbox':
        case 'fallback-dispatch':
            return decodeALOutboundQueueEffect(value);
        case 'ack-timeout':
            decodeALAdmissionRecord(value, ['kind', 'msgId']);
            requirePersistedALNonEmptyString(payload.msgId, 'acknowledgement timeout message id');
            return value as Extract<ALOutboundDurableEffect<TPrepared>, { kind: 'ack-timeout'; }>;
        case 'repair-hint':
            decodeALAdmissionRecord(value, ['kind', 'msgId', 'request']);
            requirePersistedALNonEmptyString(payload.msgId, 'repair hint message id');
            return {
                kind: 'repair-hint',
                msgId: payload.msgId as string,
                request: decodeALOutboundRepairHint(payload.request)
            };
        case 'nack-retry':
            decodeALAdmissionRecord(value, ['kind', 'msgId', 'reason']);
            requirePersistedALNonEmptyString(payload.msgId, 'negative acknowledgement retry message id');
            if (payload.reason !== 'not-yet-in-sync') {
                throw new TypeError('Persisted AL negative acknowledgement retry reason is invalid');
            }
            return value as Extract<ALOutboundDurableEffect<TPrepared>, { kind: 'nack-retry'; }>;
        default:
            throw new TypeError('Persisted AL outbound effect kind is invalid');
    }
}

function decodeALOutboundQueueEffect(
    value: unknown
): Extract<ALOutboundDurableEffect<never>, { kind: 'enqueue-outbox' | 'fallback-dispatch'; }> {
    const payload = decodeALAdmissionRecord(value, ['kind', 'msg', 'entry'], ['replaceExisting']);
    const msg = decodePersistedALMessageValue(payload.msg);
    const entry = decodeALAdmissionResourceEntry(payload.entry);
    const entryMessage = decodePersistedALMessage(entry.resource);
    if (!jsonEquals(entryMessage, msg)) {
        throw new TypeError('Persisted AL outbound queue resource differs from its message');
    }
    if (payload.kind === 'enqueue-outbox' && typeof payload.replaceExisting === 'boolean') {
        return { kind: 'enqueue-outbox', msg, entry, replaceExisting: payload.replaceExisting };
    }
    if (payload.kind === 'fallback-dispatch' && payload.replaceExisting === undefined) {
        return { kind: 'fallback-dispatch', msg, entry };
    }
    throw new TypeError('Persisted AL outbound queue effect is invalid');
}

function decodeALOutboundRepairHint(value: unknown): ALOutboundRepairHint {
    const request = decodeALAdmissionRecord(value, ['trigger', 'failedPeerIds', 'missingSeqs'], [
        'requestedByPeerId',
        'orderingTrackKey'
    ]);
    if (request.trigger !== 'ack-timeout' && request.trigger !== 'nack' && request.trigger !== 'repair') {
        throw new TypeError('Persisted AL repair trigger is invalid');
    }
    requireOptionalPersistedALNonEmptyString(request.requestedByPeerId, 'repair requester');
    requireOptionalPersistedALNonEmptyString(request.orderingTrackKey, 'repair ordering track');
    if (request.failedPeerIds === undefined) {
        throw new TypeError('Persisted AL repair peer or sequence array is missing');
    }
    requireOptionalPersistedALStringArray(request.failedPeerIds, 'failed repair peers');
    decodeALAdmissionArray(request.missingSeqs, decodeALAdmissionNumber);
    return value as ALOutboundRepairHint;
}
