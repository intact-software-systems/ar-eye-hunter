import { decodePersistedALMessageValue } from '../../al-contracts/al-message-persistence-validation.ts';
import {
    requireOptionalPersistedALNonEmptyString,
    requireOptionalPersistedALUniqueStringArray,
    requirePersistedALNonEmptyString,
    requirePersistedALSafeInteger
} from '../../al-contracts/al-message-persistence/persisted-al-value-validation.ts';
import { decodeALAdmissionResourceEntryKey } from '../al-admission-resource-entry-validation.ts';
import { decodeALAdmissionRecord } from '../al-admission-value-validation.ts';
import type {
    ALOutboundPendingAckSnapshot,
    ALOutboundRepairAttemptSnapshot,
    ALOutboundSentMessageSnapshot
} from '../al-runtime-state-stores.ts';

export function decodeALOutboundSentMessage(value: unknown, expectedMsgId: string): ALOutboundSentMessageSnapshot {
    const snapshot = decodeALAdmissionRecord(value, ['msgId', 'msg'], ['outboxKey', 'supersedenceKey']);
    requirePersistedALNonEmptyString(snapshot.msgId, 'outbound message id');
    const msg = decodePersistedALMessageValue(snapshot.msg);
    if (snapshot.msgId !== expectedMsgId || msg.id.msgId !== expectedMsgId) {
        throw new TypeError('Persisted AL outbound message identity does not match its slot');
    }
    if (snapshot.outboxKey !== undefined) {
        decodeALAdmissionResourceEntryKey(snapshot.outboxKey);
    }
    requireOptionalPersistedALNonEmptyString(snapshot.supersedenceKey, 'outbound supersedence key');
    return value as ALOutboundSentMessageSnapshot;
}

export function decodeALOutboundPendingAck(value: unknown, expectedMsgId: string): ALOutboundPendingAckSnapshot {
    const fields = ['msgId', 'expectedPeerIds', 'ackedPeerIds', 'timeoutMs', 'maxAttempts', 'attempts', 'deadlineAtMs'];
    const snapshot = decodeALAdmissionRecord(value, fields);
    requirePersistedALNonEmptyString(snapshot.msgId, 'pending acknowledgement message id');
    if (snapshot.msgId !== expectedMsgId) {
        throw new TypeError('Persisted AL pending acknowledgement identity does not match its slot');
    }
    if (snapshot.expectedPeerIds === undefined || snapshot.ackedPeerIds === undefined) {
        throw new TypeError('Persisted AL pending acknowledgement peer arrays are missing');
    }
    requireOptionalPersistedALUniqueStringArray(snapshot.expectedPeerIds, 'expected acknowledgement peers');
    requireOptionalPersistedALUniqueStringArray(snapshot.ackedPeerIds, 'acknowledged peers');
    requirePersistedALSafeInteger(snapshot.timeoutMs, 0, 'acknowledgement timeout');
    requirePersistedALSafeInteger(snapshot.maxAttempts, 0, 'acknowledgement maximum attempts');
    requirePersistedALSafeInteger(snapshot.attempts, 0, 'acknowledgement attempts');
    requirePersistedALSafeInteger(snapshot.deadlineAtMs, 0, 'acknowledgement deadline');
    return value as ALOutboundPendingAckSnapshot;
}

export function decodeALOutboundRepairAttempt(value: unknown, expectedMsgId: string): ALOutboundRepairAttemptSnapshot {
    const snapshot = decodeALAdmissionRecord(value, ['msgId', 'attempts']);
    requirePersistedALNonEmptyString(snapshot.msgId, 'repair attempt message id');
    if (snapshot.msgId !== expectedMsgId) {
        throw new TypeError('Persisted AL repair attempt identity does not match its slot');
    }
    requirePersistedALSafeInteger(snapshot.attempts, 0, 'repair attempts');
    return value as ALOutboundRepairAttemptSnapshot;
}
