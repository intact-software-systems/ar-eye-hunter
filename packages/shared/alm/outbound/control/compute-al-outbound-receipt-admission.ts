import { AL_RECEIPT_DEADLINE_GRACE_MS, type ALReceiptPayload } from '../../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../../al-contracts/al-message-persistence-validation.ts';
import type { ALOutboundPendingAckSnapshot } from '../../al-runtime-state-stores.ts';
import type { ALOutboundAdmissionMutation } from '../admission/al-outbound-admission-mutations.ts';
import type { ALOutboundVersionedClientRecord } from '../admission/al-outbound-admission-store.ts';
import type { ALStoredOutboundMessage } from '../admission/al-outbound-admission-validation.ts';
import type { ALOutboundSettlementFact } from '../al-outbound-message-runtime.ts';
import {
    isALOutboundReceiptComplete,
    toALOutboundAcknowledgementFact
} from '../transition-al-outbound-pending-ack.ts';

/** What one origin holds about the message a receipt names, read in one session. */
export interface ALOutboundReceiptAdmissionSurface {
    readonly stored: ALStoredOutboundMessage | undefined;
    readonly pending: ALOutboundPendingAckSnapshot | undefined;
    readonly clientRecord: ALOutboundVersionedClientRecord | undefined;
}

export interface ALOutboundReceiptAdmissionRead extends ALOutboundReceiptAdmissionSurface {
    readonly receipt: ALReceiptPayload;
    readonly nowMs: number;
}

/**
 * The receipt row a receipt leaves. Every phase keeps it until the message deadline plus the receipt
 * grace: a terminal receipt leaves its final snapshot, so a redelivered receipt finds nothing to move.
 */
export interface ALOutboundReceiptWrite {
    readonly value: ALOutboundPendingAckSnapshot;
    readonly expireAtTimestamp: number;
}

export interface ALOutboundReceiptAdmissionCandidate {
    readonly read: ALOutboundReceiptAdmissionRead;
    /** Undefined when the receipt names nothing it could move: validation says why. */
    readonly write: ALOutboundReceiptWrite | undefined;
}

/**
 * A receipt answers against the row an earlier receipt left, or, when none has, against the message
 * the origin sent: a terminal receipt may overtake its `admitted` one. It replaces the expected set with
 * the server's frozen audience and adds the recipients it confirmed to those already counted.
 */
export function computeALOutboundReceiptAdmission(
    read: ALOutboundReceiptAdmissionRead
): ALOutboundReceiptAdmissionCandidate {
    const current = read.pending ?? toTrackedReceipt(read);
    if (current === undefined) {
        return { read, write: undefined };
    }
    const expected = read.receipt.expectedRecipientPeerIds;
    const acked = new Set([...current.ackedPeerIds, ...read.receipt.confirmedRecipientPeerIds]);
    return {
        read,
        write: {
            value: {
                ...current,
                expectedPeerIds: expected,
                ackedPeerIds: expected.filter((peerId) => acked.has(peerId))
            },
            expireAtTimestamp: current.deadlineAtMs + AL_RECEIPT_DEADLINE_GRACE_MS
        }
    };
}

/** Every reason this receipt may not move the origin's receipt; a missing row and message make the rest moot. */
export function validateALOutboundReceiptAdmission(
    candidate: ALOutboundReceiptAdmissionCandidate
): readonly ALMessageRejection[] {
    const { read, write } = candidate;
    if (write === undefined) {
        return [toMissingReceiptRejection(read)];
    }
    const issues: ALMessageRejection[] = [];
    if (write.value.mode !== 'receiver') {
        issues.push(refuseReceipt('AL receipt names a message that tracks no receiver receipt'));
    }
    if (read.receipt.phase === 'admitted' && write.value.deadlineAtMs <= read.nowMs) {
        issues.push(refuseReceipt('AL admitted receipt arrived after its message deadline'));
    }
    if (write.expireAtTimestamp <= read.nowMs) {
        issues.push(refuseReceipt('AL receipt arrived after its message deadline and the receipt grace'));
    }
    if (read.pending !== undefined && hasSameReceipt(read.pending, write.value)) {
        issues.push(refuseReceipt('AL receipt moves no receipt of its message'));
    }
    return issues;
}

export function toALOutboundReceiptMutation(
    write: ALOutboundReceiptWrite,
    receipt: ALReceiptPayload
): ALOutboundAdmissionMutation {
    return {
        kind: 'set-pending-ack',
        originPeerId: receipt.originPeerId,
        snapshot: write.value,
        expireAtTimestamp: write.expireAtTimestamp
    };
}

/** The receipt as the delivery fact its commit states; a `timed-out` aggregate never completes it. */
export function toALOutboundReceiptSettlement(
    write: ALOutboundReceiptWrite,
    receipt: ALReceiptPayload
): ALOutboundSettlementFact {
    return toALOutboundAcknowledgementFact(
        write.value,
        receipt.phase !== 'timed-out' && isALOutboundReceiptComplete(write.value)
    );
}

/**
 * The receipt row the origin's sent message would have: the server's receipts own its schedule, so no
 * `ack-timeout` work is written for it, and its deadline is the message's.
 */
function toTrackedReceipt(read: ALOutboundReceiptAdmissionRead): ALOutboundPendingAckSnapshot | undefined {
    const { stored, receipt } = read;
    const tracking = stored?.policy.ackTracking;
    if (!stored || stored.reference.senderId !== receipt.originPeerId || !tracking) {
        return undefined;
    }
    return {
        msgId: receipt.msgId,
        mode: tracking.mode,
        expectedPeerIds: [],
        ackedPeerIds: [],
        timeoutMs: tracking.timeoutMs,
        maxAttempts: tracking.maxAttempts,
        attempts: 0,
        deadlineAtMs: stored.reference.expiresAtMs
    };
}

function toMissingReceiptRejection(read: ALOutboundReceiptAdmissionRead): ALMessageRejection {
    return read.stored && read.stored.reference.senderId === read.receipt.originPeerId
        ? refuseReceipt('AL receipt names a message that tracks no receiver receipt')
        : refuseReceipt('AL receipt names no retained outbound message of its origin');
}

function hasSameReceipt(pending: ALOutboundPendingAckSnapshot, next: ALOutboundPendingAckSnapshot): boolean {
    return hasSamePeers(pending.expectedPeerIds, next.expectedPeerIds) &&
        hasSamePeers(pending.ackedPeerIds, next.ackedPeerIds);
}

function hasSamePeers(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((peerId) => right.includes(peerId));
}

/** The code the control admission refuses an already-counted or unmatched acknowledgement with. */
function refuseReceipt(message: string): ALMessageRejection {
    return { code: 'unauthorized', message };
}
