import {
    requireOptionalPersistedALNonEmptyString,
    requireOptionalPersistedALUniqueStringArray,
    requirePersistedALBoolean,
    requirePersistedALNonEmptyString,
    requirePersistedALSafeInteger,
    type PersistedALValue
} from '../../../al-contracts/al-message-persistence/persisted-al-value-validation.ts';
import { isALLogicalReceiptMode } from '../../../al-contracts/validate-al-ack-support.ts';
import type { StateScope } from '../../../api/state-types.ts';
import { decodeALAdmissionRecord, decodeALAdmissionString } from '../../al-admission-value-validation.ts';
import type {
    ALOutboundNotYetInSyncRetrySnapshot,
    ALOutboundPendingAckSnapshot,
    ALOutboundRepairAttemptSnapshot
} from '../../al-runtime-state-stores.ts';
import type { ALStoreDurability } from '../../al-runtime-stores.ts';
import { decodeALOutboundMessageReference, type ALOutboundMessageReference } from '../al-outbound-canonical-message.ts';
import type { ALOutboundDispatchPlan } from '../al-outbound-message-runtime.ts';
import { toALOutboundEffectId } from '../to-al-outbound-effect-id.ts';
import {
    decodeALSessionInvalidationAuthority,
    type ALSessionInvalidationAuthority
} from './al-session-invalidation-authority.ts';

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
    /** Whether the copy outlives the volatile lane; the row keeps no finer lane. */
    readonly persist: boolean;
    readonly ackTracking: NonNullable<ALOutboundDispatchPlan<never>['ackTracking']> | null;
    readonly retryTracking: NonNullable<ALOutboundDispatchPlan<never>['retryTracking']> | null;
    readonly repairTracking: NonNullable<ALOutboundDispatchPlan<never>['repairTracking']> | null;
    readonly supersedenceTracking: NonNullable<ALOutboundDispatchPlan<never>['supersedenceTracking']> | null;
    /** Kept only for a WS server publication whose admission mints its sequence, so a retained replay mints too. */
    readonly mintsSequence?: true;
    /** Kept only for a message a server admitted to an audience; absent for every other message. */
    readonly admittedAudience?: readonly string[];
    readonly recipientScope?: StateScope;
    readonly principalTargetId?: string;
    readonly sessionInvalidation?: ALSessionInvalidationAuthority;
}

export function captureALOutboundPolicy<TPrepared>(plan: ALOutboundDispatchPlan<TPrepared>): ALOutboundCapturedPolicy {
    return {
        persist: plan.lane !== 'volatile',
        ackTracking: plan.ackTracking ?? null,
        retryTracking: plan.retryTracking ?? null,
        repairTracking: plan.repairTracking ?? null,
        supersedenceTracking: plan.supersedenceTracking ?? null,
        ...(plan.mintsSequence ? { mintsSequence: true } : {}),
        ...(plan.admittedAudience === undefined ? {} : { admittedAudience: plan.admittedAudience }),
        ...(plan.sessionInvalidation === undefined
            ? {}
            : { sessionInvalidation: decodeALSessionInvalidationAuthority(plan.sessionInvalidation) }),
        ...(plan.recipientScope === undefined
            ? {}
            : { recipientScope: decodeALOutboundRecipientScope(plan.recipientScope) }),
        ...(plan.principalTargetId === undefined ? {} : { principalTargetId: plan.principalTargetId })
    };
}

/**
 * A sent message keeps the policy of its first dispatch, except the next hops of its acknowledgement: a
 * retry that re-plans the receipt records the hops of the local view it planned over, so a settlement
 * names the hops of the latest tree, never those of a tree that has changed since.
 */
export function toALOutboundSentPolicy<TPrepared>(
    stored: ALOutboundCapturedPolicy | undefined,
    plan: ALOutboundDispatchPlan<TPrepared>
): ALOutboundCapturedPolicy {
    if (stored === undefined) {
        return captureALOutboundPolicy(plan);
    }
    const tracking = plan.ackTracking;
    return tracking?.expectedPeerIdsUpdate === 'replace' && stored.ackTracking
        ? { ...stored, ackTracking: { ...stored.ackTracking, nextHopPeerIds: tracking.nextHopPeerIds } }
        : stored;
}

export function toALOutboundCapturedLane(policy: ALOutboundCapturedPolicy): ALStoreDurability {
    return policy.persist ? 'durable' : 'volatile';
}

export function applyALOutboundCapturedPolicy<TPrepared>(
    plan: ALOutboundDispatchPlan<TPrepared>,
    policy: ALOutboundCapturedPolicy
): ALOutboundDispatchPlan<TPrepared> {
    return {
        ...plan,
        lane: policy.persist === (plan.lane !== 'volatile') ? plan.lane : toALOutboundCapturedLane(policy),
        ackTracking: policy.ackTracking
            ? {
                ...policy.ackTracking,
                expectedPeerIds: plan.ackTracking?.expectedPeerIds ??
                    (isALLogicalReceiptMode(policy.ackTracking.mode)
                        ? policy.ackTracking.expectedPeerIds
                        : plan.receiptNextHopPeerIds ?? []),
                expectedPeerIdsUpdate: plan.ackTracking?.expectedPeerIdsUpdate,
                nextHopPeerIds: plan.ackTracking?.nextHopPeerIds ?? plan.receiptNextHopPeerIds ?? []
            }
            : undefined,
        retryTracking: policy.retryTracking ?? undefined,
        repairTracking: policy.repairTracking ?? undefined,
        supersedenceTracking: policy.supersedenceTracking ?? undefined,
        admittedAudience: policy.admittedAudience,
        recipientScope: policy.recipientScope,
        principalTargetId: policy.principalTargetId,
        sessionInvalidation: policy.sessionInvalidation
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
    ], ['mintsSequence', 'admittedAudience', 'recipientScope', 'principalTargetId', 'sessionInvalidation']);
    if (policy.mintsSequence !== undefined && policy.mintsSequence !== true) {
        throw new TypeError('Captured sequence minting is invalid');
    }
    if (policy.sessionInvalidation !== undefined) {
        decodeALSessionInvalidationAuthority(policy.sessionInvalidation);
        if (policy.recipientScope !== undefined) {
            throw new TypeError('Session-global authority cannot carry a scoped authority');
        }
    }
    requireOptionalPersistedALUniqueStringArray(policy.admittedAudience, 'captured admitted audience');
    if (policy.recipientScope !== undefined) {
        decodeALOutboundRecipientScope(policy.recipientScope);
    }
    if (policy.principalTargetId !== undefined) {
        requirePersistedALNonEmptyString(policy.principalTargetId, 'captured principal target');
        if (policy.recipientScope === undefined || policy.admittedAudience === undefined) {
            throw new TypeError('Captured principal target requires scope and frozen audience');
        }
    }
    if (typeof policy.persist !== 'boolean') {
        throw new TypeError('Captured outbound persistence policy is invalid');
    }
    if (policy.ackTracking !== null) {
        decodeALOutboundCapturedAcknowledgement(policy.ackTracking);
    }
    decodeALOutboundCapturedRetry(policy.retryTracking);
    decodeALOutboundCapturedRepair(policy.repairTracking);
    decodeALOutboundCapturedSupersedence(policy.supersedenceTracking);
    return value as ALOutboundCapturedPolicy;
}

function decodeALOutboundCapturedRetry(value: PersistedALValue | undefined): void {
    if (value === null) {
        return;
    }
    const retry = decodeALAdmissionRecord(value, ['enabled', 'maxAttempts'], ['retryDelayMs']);
    requirePersistedALBoolean(retry.enabled, 'captured retry tracking flag');
    requirePersistedALSafeInteger(retry.maxAttempts, 0, 'captured retry attempts');
    if (retry.retryDelayMs !== undefined) {
        requirePersistedALSafeInteger(retry.retryDelayMs, 0, 'captured retry delay');
    }
}

function decodeALOutboundCapturedRepair(value: PersistedALValue | undefined): void {
    if (value === null) {
        return;
    }
    const repair = decodeALAdmissionRecord(value, ['enabled', 'algo', 'maxAttempts']);
    requirePersistedALBoolean(repair.enabled, 'captured repair tracking flag');
    requirePersistedALSafeInteger(repair.maxAttempts, 0, 'captured repair attempts');
    if (repair.algo !== 'none' && repair.algo !== 'retransmit') {
        throw new TypeError('Captured repair algorithm is invalid');
    }
}

function decodeALOutboundCapturedSupersedence(value: PersistedALValue | undefined): void {
    if (value === null) {
        return;
    }
    const supersedence = decodeALAdmissionRecord(value, ['enabled', 'algo'], ['key', 'replacesMsgId']);
    requirePersistedALBoolean(supersedence.enabled, 'captured supersedence tracking flag');
    requireOptionalPersistedALNonEmptyString(supersedence.key, 'captured supersedence key');
    requireOptionalPersistedALNonEmptyString(supersedence.replacesMsgId, 'captured replaced message');
    if (supersedence.algo !== 'none' && supersedence.algo !== 'latest-wins') {
        throw new TypeError('Captured supersedence algorithm is invalid');
    }
}

export function decodeALOutboundPendingAck(value: unknown, expectedMsgId: string): ALOutboundPendingAckSnapshot {
    const fields = [
        'msgId',
        'mode',
        'expectedPeerIds',
        'ackedPeerIds',
        'timeoutMs',
        'maxAttempts',
        'attempts',
        'deadlineAtMs'
    ];
    const snapshot = decodeALAdmissionRecord(value, fields);
    requirePersistedALNonEmptyString(snapshot.msgId, 'pending acknowledgement message id');
    if (snapshot.msgId !== expectedMsgId) {
        throw new TypeError('Persisted AL pending acknowledgement identity does not match its slot');
    }
    requirePersistedALReceiptMode(snapshot.mode, 'pending acknowledgement mode');
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

function requirePersistedALReceiptMode(value: PersistedALValue | undefined, label: string): void {
    if (value !== 'hop' && value !== 'subtree' && value !== 'receiver' && value !== 'leader') {
        throw new TypeError(`Persisted AL ${label} is invalid`);
    }
}

export function decodeALOutboundRecipientScope(value: unknown): StateScope {
    const scope = decodeALAdmissionRecord(value, ['applicationId', 'workspaceId']);
    return {
        applicationId: decodeALAdmissionString(scope.applicationId),
        workspaceId: decodeALAdmissionString(scope.workspaceId)
    };
}

export function validateALOutboundRecipientScope(value: StateScope | null | undefined): readonly string[] {
    try {
        decodeALOutboundRecipientScope(value);
        return [];
    }
    catch {
        return ['Public WS unicast requires explicit application and workspace scope'];
    }
}

function decodeALOutboundCapturedAcknowledgement(value: PersistedALValue | undefined): void {
    const ack = decodeALAdmissionRecord(value, [
        'enabled',
        'timeoutMs',
        'maxAttempts',
        'expectedPeerIds',
        'nextHopPeerIds',
        'mode'
    ], ['expectedPeerIdsUpdate']);
    requirePersistedALBoolean(ack.enabled, 'captured acknowledgement tracking flag');
    requirePersistedALSafeInteger(ack.timeoutMs, 0, 'captured acknowledgement timeout');
    requirePersistedALSafeInteger(ack.maxAttempts, 0, 'captured acknowledgement attempts');
    if (!Array.isArray(ack.expectedPeerIds)) {
        throw new TypeError('Captured acknowledgement peers are missing');
    }
    requireOptionalPersistedALUniqueStringArray(ack.expectedPeerIds, 'captured acknowledgement peers');
    if (!Array.isArray(ack.nextHopPeerIds)) {
        throw new TypeError('Captured acknowledgement next hops are missing');
    }
    requireOptionalPersistedALUniqueStringArray(ack.nextHopPeerIds, 'captured acknowledgement next hops');
    if (
        ack.expectedPeerIdsUpdate !== undefined && ack.expectedPeerIdsUpdate !== 'merge' &&
        ack.expectedPeerIdsUpdate !== 'replace'
    ) {
        throw new TypeError('Captured acknowledgement peer update is invalid');
    }
    requirePersistedALReceiptMode(ack.mode, 'captured acknowledgement mode');
}
