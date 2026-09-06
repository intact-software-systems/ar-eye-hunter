import type { ALMessage } from '../../al-contracts/al-contract.ts';
import {
    decodePersistedALMessage,
    decodePersistedALMessageValue
} from '../../al-contracts/al-message-persistence-validation.ts';
import {
    requireOptionalPersistedALNonEmptyString,
    requireOptionalPersistedALStringArray,
    requirePersistedALNonEmptyString
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
    ALOutboundRepairHint
} from './al-outbound-admission-store.ts';
import { toALOutboundEffectId } from './to-al-outbound-effect-id.ts';
import { toALOutboundPreparedFingerprint } from './to-al-outbound-prepared-fingerprint.ts';

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

interface RequireALOutboundSendEffectIdentityInput {
    readonly effectId: string;
    readonly msgId: string;
    readonly phase: 'dequeue' | 'immediate';
    readonly preparedFingerprint: string;
}

export function encodeALOutboundEffectPayload<TPrepared>(
    payload: ALOutboundDurableEffect<TPrepared>
): StoredALOutboundDurableEffect<TPrepared> {
    switch (payload.kind) {
        case 'enqueue-outbox':
        case 'fallback-dispatch':
            return { ...payload, entry: encodeALAdmissionResourceEntry(payload.entry) };
        default:
            return payload;
    }
}

export function decodeALOutboundPreparedMessage(value: unknown, msg: ALMessage): ALMessage {
    const prepared = decodePersistedALMessageValue(value);
    if (!isPreparedTransportCopy(prepared, msg)) {
        throw new TypeError('Persisted AL prepared message does not match its outbound message');
    }
    return prepared;
}

function isPreparedTransportCopy(prepared: ALMessage, source: ALMessage): boolean {
    const sourceAuthority = {
        ...source,
        forwarding: undefined,
        constraints: undefined,
        diagnostics: undefined
    };
    const preparedAuthority = {
        ...prepared,
        forwarding: undefined,
        constraints: undefined,
        diagnostics: undefined
    };
    if (!jsonEquals(preparedAuthority, sourceAuthority)) {
        return false;
    }
    if (prepared.forwarding?.fanoutLimit !== source.forwarding?.fanoutLimit) {
        return false;
    }
    if (
        source.forwarding?.overlayId !== undefined &&
        prepared.forwarding?.overlayId !== source.forwarding.overlayId
    ) {
        return false;
    }
    if (prepared.constraints?.expiresAtMs !== source.constraints?.expiresAtMs) {
        return false;
    }
    const sourceTtl = source.constraints?.ttlHops;
    const preparedTtl = prepared.constraints?.ttlHops;
    if (preparedTtl !== sourceTtl && (sourceTtl === undefined || preparedTtl !== sourceTtl - 1)) {
        return false;
    }
    const sourceVisited = source.diagnostics?.visitedPeerIds ?? [];
    const preparedVisited = prepared.diagnostics?.visitedPeerIds ?? [];
    return sourceVisited.every((peerId, index) => preparedVisited[index] === peerId);
}

export function decodeALOutboundEffectPayload<TPrepared>(
    value: unknown,
    effectId: string,
    decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
): ALOutboundDurableEffect<TPrepared> {
    const payload = decodeALAdmissionRecord(value, ['kind'], [
        'msg',
        'prepared',
        'preparedFingerprint',
        'phase',
        'entry',
        'replaceExisting',
        'msgId',
        'request',
        'reason'
    ]);
    switch (payload.kind) {
        case 'send-prepared': {
            decodeALAdmissionRecord(value, ['kind', 'msg', 'prepared', 'preparedFingerprint', 'phase']);
            const msg = decodePersistedALMessageValue(payload.msg);
            requirePersistedALNonEmptyString(payload.preparedFingerprint, 'prepared message fingerprint');
            if (payload.preparedFingerprint !== toALOutboundPreparedFingerprint(payload.prepared)) {
                throw new TypeError('Persisted AL prepared message fingerprint does not match its payload');
            }
            if (payload.phase !== 'immediate' && payload.phase !== 'dequeue') {
                throw new TypeError('Persisted AL outbound send phase is invalid');
            }
            requireALOutboundSendEffectIdentity({
                effectId,
                msgId: msg.id.msgId,
                phase: payload.phase,
                preparedFingerprint: payload.preparedFingerprint
            });
            return {
                kind: 'send-prepared',
                msg,
                prepared: decodePrepared(payload.prepared, msg),
                preparedFingerprint: payload.preparedFingerprint,
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
            const msgId = payload.msgId as string;
            if (payload.reason !== 'not-yet-in-sync') {
                throw new TypeError('Persisted AL negative acknowledgement retry reason is invalid');
            }
            requireALOutboundNotYetInSyncRetryEffectIdentity(effectId, msgId);
            return value as Extract<ALOutboundDurableEffect<TPrepared>, { kind: 'nack-retry'; }>;
        default:
            throw new TypeError('Persisted AL outbound effect kind is invalid');
    }
}

function requireALOutboundNotYetInSyncRetryEffectIdentity(
    effectId: string,
    msgId: string
): void {
    const prefix = `${toALOutboundEffectId(['nack-retry', msgId, 'not-yet-in-sync'])}:`;
    if (!effectId.startsWith(prefix)) {
        throw new TypeError('Persisted AL negative acknowledgement retry identity is invalid');
    }
    const encodedAttempt = effectId.slice(prefix.length);
    const attempt = Number(encodedAttempt);
    if (
        !Number.isSafeInteger(attempt) ||
        attempt < 1 ||
        String(attempt) !== encodedAttempt ||
        effectId !== toALOutboundEffectId(['nack-retry', msgId, 'not-yet-in-sync', attempt])
    ) {
        throw new TypeError('Persisted AL negative acknowledgement retry identity is invalid');
    }
}

function requireALOutboundSendEffectIdentity(
    input: RequireALOutboundSendEffectIdentityInput
): void {
    const { effectId, msgId, phase, preparedFingerprint } = input;
    const prefix = `${toALOutboundEffectId(['send', msgId, phase])}:`;
    const suffix = `:${encodeURIComponent(preparedFingerprint)}`;
    if (!effectId.startsWith(prefix) || !effectId.endsWith(suffix)) {
        throw new TypeError('Persisted AL prepared message fingerprint does not match its effect identity');
    }
    const encodedIndex = effectId.slice(prefix.length, effectId.length - suffix.length);
    const index = Number(encodedIndex);
    if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        String(index) !== encodedIndex ||
        effectId !== toALOutboundEffectId(['send', msgId, phase, index, preparedFingerprint])
    ) {
        throw new TypeError('Persisted AL outbound send effect identity is invalid');
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
