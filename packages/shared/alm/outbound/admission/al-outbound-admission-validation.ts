import {
    requireOptionalPersistedALNonEmptyString,
    requireOptionalPersistedALUniqueStringArray,
    requirePersistedALNonEmptyString,
    requirePersistedALSafeInteger
} from '../../../al-contracts/al-message-persistence/persisted-al-value-validation.ts';
import { decodeALAdmissionRecord } from '../../al-admission-value-validation.ts';
import type {
    ALOutboundNotYetInSyncRetrySnapshot,
    ALOutboundPendingAckSnapshot,
    ALOutboundRepairAttemptSnapshot
} from '../../al-runtime-state-stores.ts';
import { decodeALOutboundMessageReference, type ALOutboundMessageReference } from '../al-outbound-canonical-message.ts';
import type { ALOutboundDispatchPlan } from '../al-outbound-message-runtime.ts';
import { toALOutboundEffectId } from '../to-al-outbound-effect-id.ts';

export interface ALStoredOutboundMessage {
    readonly msgId: string;
    readonly reference: ALOutboundMessageReference;
    readonly supersedenceKey: string | undefined;
    readonly unicastPeerId: string | null;
    readonly orderingTrackKey: string | null;
    readonly orderingSeq: number | null;
    readonly policy: ALOutboundCapturedPolicy;
    readonly creationExpiry: string;
}

export interface ALOutboundCapturedPolicy {
    readonly persist: boolean;
    readonly ackTracking: NonNullable<ALOutboundDispatchPlan<never>['ackTracking']> | null;
    readonly retryTracking: NonNullable<ALOutboundDispatchPlan<never>['retryTracking']> | null;
    readonly repairTracking: NonNullable<ALOutboundDispatchPlan<never>['repairTracking']> | null;
    readonly supersedenceTracking: NonNullable<ALOutboundDispatchPlan<never>['supersedenceTracking']> | null;
}

export function captureALOutboundPolicy<TPrepared>(plan: ALOutboundDispatchPlan<TPrepared>): ALOutboundCapturedPolicy {
    return {
        persist: plan.persist,
        ackTracking: plan.ackTracking ?? null,
        retryTracking: plan.retryTracking ?? null,
        repairTracking: plan.repairTracking ?? null,
        supersedenceTracking: plan.supersedenceTracking ?? null
    };
}

export function applyALOutboundCapturedPolicy<TPrepared>(
    plan: ALOutboundDispatchPlan<TPrepared>,
    policy: ALOutboundCapturedPolicy
): ALOutboundDispatchPlan<TPrepared> {
    return {
        ...plan,
        persist: policy.persist,
        ackTracking: policy.ackTracking
            ? {
                ...policy.ackTracking,
                expectedPeerIds: plan.ackTracking?.expectedPeerIds ?? [],
                mode: plan.ackTracking?.mode
            }
            : undefined,
        retryTracking: policy.retryTracking ?? undefined,
        repairTracking: policy.repairTracking ?? undefined,
        supersedenceTracking: policy.supersedenceTracking ?? undefined
    };
}

export function decodeALOutboundSentMessage(value: unknown, expectedMsgId: string): ALStoredOutboundMessage {
    const snapshot = decodeALAdmissionRecord(value, [
        'msgId',
        'reference',
        'unicastPeerId',
        'orderingTrackKey',
        'orderingSeq',
        'policy',
        'creationExpiry'
    ], ['supersedenceKey']);
    const reference = decodeALOutboundMessageReference(snapshot.reference);
    if (snapshot.msgId !== expectedMsgId || reference.msgId !== expectedMsgId) {
        throw new TypeError('Persisted AL outbound message identity does not match its slot');
    }
    requireOptionalPersistedALNonEmptyString(snapshot.supersedenceKey, 'outbound supersedence key');
    requireOptionalPersistedALNonEmptyString(snapshot.unicastPeerId ?? undefined, 'outbound unicast peer');
    requireOptionalPersistedALNonEmptyString(snapshot.orderingTrackKey ?? undefined, 'outbound ordering track');
    if (snapshot.orderingSeq !== null) {
        requirePersistedALSafeInteger(snapshot.orderingSeq, 0, 'outbound ordering sequence');
    }
    requirePersistedALNonEmptyString(snapshot.creationExpiry, 'outbound creation expiry observation');
    decodeALOutboundCapturedPolicy(snapshot.policy);
    return { ...value as ALStoredOutboundMessage, reference };
}

export function decodeALOutboundCapturedPolicy(value: unknown): ALOutboundCapturedPolicy {
    const policy = decodeALAdmissionRecord(value, [
        'persist',
        'ackTracking',
        'retryTracking',
        'repairTracking',
        'supersedenceTracking'
    ]);
    if (typeof policy.persist !== 'boolean') {
        throw new TypeError('Captured outbound persistence policy is invalid');
    }
    if (policy.ackTracking !== null) {
        const ack = decodeALAdmissionRecord(policy.ackTracking, [
            'enabled',
            'timeoutMs',
            'maxAttempts',
            'expectedPeerIds'
        ], ['mode']);
        decodeEnabledFlag(ack.enabled);
        requirePersistedALSafeInteger(ack.timeoutMs, 0, 'captured acknowledgement timeout');
        requirePersistedALSafeInteger(ack.maxAttempts, 0, 'captured acknowledgement attempts');
        if (!Array.isArray(ack.expectedPeerIds)) {
            throw new TypeError('Captured acknowledgement peers are missing');
        }
        requireOptionalPersistedALUniqueStringArray(ack.expectedPeerIds, 'captured acknowledgement peers');
        if (ack.mode !== undefined && ack.mode !== 'merge' && ack.mode !== 'replace') {
            throw new TypeError('Captured acknowledgement mode is invalid');
        }
    }
    if (policy.retryTracking !== null) {
        const retry = decodeALAdmissionRecord(policy.retryTracking, ['enabled', 'maxAttempts'], ['retryDelayMs']);
        decodeEnabledFlag(retry.enabled);
        requirePersistedALSafeInteger(retry.maxAttempts, 0, 'captured retry attempts');
        if (retry.retryDelayMs !== undefined) {
            requirePersistedALSafeInteger(retry.retryDelayMs, 0, 'captured retry delay');
        }
    }
    if (policy.repairTracking !== null) {
        const repair = decodeALAdmissionRecord(policy.repairTracking, ['enabled', 'algo', 'maxAttempts']);
        decodeEnabledFlag(repair.enabled);
        requirePersistedALSafeInteger(repair.maxAttempts, 0, 'captured repair attempts');
        if (repair.algo !== 'none' && repair.algo !== 'retransmit') {
            throw new TypeError('Captured repair algorithm is invalid');
        }
    }
    if (policy.supersedenceTracking !== null) {
        const supersedence = decodeALAdmissionRecord(policy.supersedenceTracking, ['enabled', 'algo'], [
            'key',
            'replacesMsgId'
        ]);
        decodeEnabledFlag(supersedence.enabled);
        requireOptionalPersistedALNonEmptyString(supersedence.key, 'captured supersedence key');
        requireOptionalPersistedALNonEmptyString(supersedence.replacesMsgId, 'captured replaced message');
        if (supersedence.algo !== 'none' && supersedence.algo !== 'latest-wins') {
            throw new TypeError('Captured supersedence algorithm is invalid');
        }
    }
    return value as ALOutboundCapturedPolicy;
}

function decodeEnabledFlag(value: unknown): boolean {
    if (typeof value !== 'boolean') {
        throw new TypeError('Captured outbound policy enabled flag is invalid');
    }
    return value;
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

export function decodeALOutboundNotYetInSyncRetry(
    value: unknown,
    expectedMsgId: string
): ALOutboundNotYetInSyncRetrySnapshot {
    const snapshot = decodeALAdmissionRecord(value, ['msgId', 'attempts', 'pendingEffectId']);
    requirePersistedALNonEmptyString(snapshot.msgId, 'not-yet-in-sync retry message id');
    if (snapshot.msgId !== expectedMsgId) {
        throw new TypeError('Persisted AL not-yet-in-sync retry identity does not match its slot');
    }
    requirePersistedALSafeInteger(snapshot.attempts, 1, 'not-yet-in-sync retry attempts');
    requirePersistedALNonEmptyString(snapshot.pendingEffectId, 'not-yet-in-sync retry effect id');
    const expectedEffectId = toALOutboundEffectId([
        'nack-retry',
        expectedMsgId,
        'not-yet-in-sync',
        snapshot.attempts as number
    ]);
    if (snapshot.pendingEffectId !== expectedEffectId) {
        throw new TypeError('Persisted AL not-yet-in-sync retry effect identity does not match its snapshot');
    }
    return value as ALOutboundNotYetInSyncRetrySnapshot;
}
