import {
    requirePersistedALNonEmptyString,
    requirePersistedALSafeInteger
} from '../../../al-contracts/al-message-persistence/persisted-al-value-validation.ts';
import { decodeALAdmissionRecord } from '../../al-admission-value-validation.ts';
import type { ALOutboundFirstHopWaitSnapshot } from './compute-al-outbound-first-hop-wait.ts';

export function decodeALOutboundFirstHopWait(value: unknown, expectedMsgId: string): ALOutboundFirstHopWaitSnapshot {
    const snapshot = decodeALAdmissionRecord(value, [
        'msgId',
        'timeoutMs',
        'maxAttempts',
        'attempts',
        'deadlineAtMs',
        'attemptIdentity',
        'phase'
    ]);
    requirePersistedALNonEmptyString(snapshot.msgId, 'first-hop wait message id');
    if (snapshot.msgId !== expectedMsgId) {
        throw new TypeError('Persisted AL first-hop wait identity does not match its slot');
    }
    requirePersistedALSafeInteger(snapshot.timeoutMs, 1, 'first-hop wait timeout');
    requirePersistedALSafeInteger(snapshot.maxAttempts, 1, 'first-hop wait maximum attempts');
    requirePersistedALSafeInteger(snapshot.attempts, 0, 'first-hop wait attempts');
    requirePersistedALSafeInteger(snapshot.deadlineAtMs, 0, 'first-hop wait deadline');
    requirePersistedALNonEmptyString(snapshot.attemptIdentity, 'first-hop wait attempt identity');
    if (snapshot.phase !== 'immediate' && snapshot.phase !== 'dequeue') {
        throw new TypeError('Persisted AL first-hop wait phase is invalid');
    }
    return value as ALOutboundFirstHopWaitSnapshot;
}
