import type { ALMessage } from '../../al-contracts/al-contract.ts';
import {
    decodePersistedALMessageValue
} from '../../al-contracts/al-message-persistence-validation.ts';
import {
    requireOptionalPersistedALNonEmptyString,
    requireOptionalPersistedALStringArray,
    requirePersistedALNonEmptyString
} from '../../al-contracts/al-message-persistence/persisted-al-value-validation.ts';
import { resolveALMessageExpireAtMs } from '../../al-contracts/al-policy.ts';
import { jsonEquals } from '../../repository/state-utils.ts';
import {
    decodeALAdmissionArray,
    decodeALAdmissionNumber,
    decodeALAdmissionRecord
} from '../al-admission-value-validation.ts';
import type {
    ALOutboundDurableEffect,
    ALOutboundPreparedMessageDecoder,
    ALOutboundRepairHint
} from './admission/al-outbound-admission-store.ts';
import { decodeALOutboundCapturedPolicy } from './admission/al-outbound-admission-validation.ts';
import { decodeALOutboundMessageReference } from './al-outbound-canonical-message.ts';
import {
    toALOutboundPendingAdmissionId,
    toALOutboundPendingControlId,
    type ALOutboundPendingAdmission
} from './al-outbound-pending-admission.ts';
import { toALOutboundEffectId } from './to-al-outbound-effect-id.ts';
import { toALOutboundPreparedFingerprint } from './to-al-outbound-prepared-fingerprint.ts';

export interface ALOutboundPreparedRead<TPrepared> {
    readonly decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>;
    readonly message: ALMessage | undefined;
}

interface RequireALOutboundSendEffectIdentityInput {
    readonly effectId: string;
    readonly msgId: string;
    readonly phase: 'dequeue' | 'immediate';
    readonly attemptIdentity: string;
    readonly preparedFingerprint: string;
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
    preparedRead: ALOutboundPreparedRead<TPrepared>
): ALOutboundDurableEffect<TPrepared> {
    const payload = decodeALAdmissionRecord(value, ['kind'], [
        'message',
        'prepared',
        'preparedFingerprint',
        'attemptIdentity',
        'phase',
        'entry',
        'replaceExisting',
        'msgId',
        'request',
        'reason',
        'policy',
        'preparedMessages',
        'msg',
        'expiresAtMs'
    ]);
    switch (payload.kind) {
        case 'admit-control':
            return decodeALOutboundPendingControl(value, effectId);
        case 'admit-message':
            return decodeALOutboundPendingAdmission(value, effectId, preparedRead);
        case 'send-prepared':
            return decodeALOutboundSendEffect(value, effectId, preparedRead);
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

function decodeALOutboundPendingControl(
    value: unknown,
    effectId: string
): Extract<ALOutboundDurableEffect<never>, { kind: 'admit-control'; }> {
    const pending = decodeALAdmissionRecord(value, ['kind', 'msg', 'expiresAtMs']);
    const msg = decodePersistedALMessageValue(pending.msg);
    const expiresAtMs = decodeALAdmissionNumber(pending.expiresAtMs);
    if (effectId !== toALOutboundPendingControlId(msg)) {
        throw new TypeError('Pending outbound control identity differs from its queue observation');
    }
    return { kind: 'admit-control', msg, expiresAtMs };
}

function decodeALOutboundPendingAdmission<TPrepared>(
    value: unknown,
    effectId: string,
    read: ALOutboundPreparedRead<TPrepared>
): ALOutboundPendingAdmission<TPrepared> {
    const pending = decodeALAdmissionRecord(value, ['kind', 'message', 'policy', 'preparedMessages']);
    const message = decodeALOutboundMessageReference(pending.message);
    const canonical = read.message;
    if (
        !canonical || canonical.id.msgId !== message.msgId || canonical.id.senderId !== message.senderId ||
        resolveALMessageExpireAtMs(canonical) !== message.expiresAtMs ||
        effectId !== toALOutboundPendingAdmissionId(message)
    ) {
        throw new TypeError('Pending admission requires its exact canonical message');
    }
    return {
        kind: 'admit-message',
        message,
        policy: decodeALOutboundCapturedPolicy(pending.policy),
        preparedMessages: decodeALAdmissionArray(
            pending.preparedMessages,
            (prepared) => read.decodePrepared(prepared, canonical)
        )
    };
}

function decodeALOutboundSendEffect<TPrepared>(
    value: unknown,
    effectId: string,
    preparedRead: ALOutboundPreparedRead<TPrepared>
): Extract<ALOutboundDurableEffect<TPrepared>, { kind: 'send-prepared'; }> {
    const payload = decodeALAdmissionRecord(value, [
        'kind',
        'message',
        'prepared',
        'preparedFingerprint',
        'attemptIdentity',
        'phase'
    ]);
    const message = decodeALOutboundMessageReference(payload.message);
    const msg = preparedRead.message;
    if (
        !msg || msg.id.msgId !== message.msgId || msg.id.senderId !== message.senderId ||
        resolveALMessageExpireAtMs(msg) !== message.expiresAtMs
    ) {
        throw new TypeError('Prepared attempt requires its exact canonical message');
    }
    requirePersistedALNonEmptyString(payload.attemptIdentity, 'prepared attempt identity');
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
        attemptIdentity: payload.attemptIdentity as string,
        preparedFingerprint: payload.preparedFingerprint
    });
    return {
        kind: 'send-prepared',
        message,
        prepared: preparedRead.decodePrepared(payload.prepared, msg),
        preparedFingerprint: payload.preparedFingerprint,
        attemptIdentity: payload.attemptIdentity as string,
        phase: payload.phase
    };
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
    const { effectId, msgId, phase, attemptIdentity, preparedFingerprint } = input;
    const prefix = `${toALOutboundEffectId(['send', msgId, phase, attemptIdentity])}:`;
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
        effectId !== toALOutboundEffectId(['send', msgId, phase, attemptIdentity, index, preparedFingerprint])
    ) {
        throw new TypeError('Persisted AL outbound send effect identity is invalid');
    }
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
