import type { ALReceiptPayload } from '../../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../../al-contracts/al-message-persistence-validation.ts';
import type { ALOutboundPendingAckSnapshot } from '../../al-runtime-state-stores.ts';
import type { ALOutboundAdmissionMutation } from '../admission/al-outbound-admission-mutations.ts';
import type { ALOutboundVersionedClientRecord } from '../admission/al-outbound-admission-store.ts';
import type { ALStoredOutboundMessage } from '../admission/al-outbound-admission-validation.ts';
import type { ALOutboundSettlementFact } from '../al-outbound-message-runtime.ts';
import { isALOutboundReceiptComplete } from '../transition-al-outbound-pending-ack.ts';

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

export type ALOutboundReceiptWrite =
    | Readonly<{ kind: 'set'; value: ALOutboundPendingAckSnapshot; }>
    | Readonly<{ kind: 'remove'; value: ALOutboundPendingAckSnapshot; }>;

export interface ALOutboundReceiptAdmissionCandidate {
    readonly read: ALOutboundReceiptAdmissionRead;
    /** Undefined when the named message tracks no receiver receipt: validation refuses it. */
    readonly write: ALOutboundReceiptWrite | undefined;
}

/**
 * A receipt replaces the expected set with the server's frozen audience and adds the recipients it
 * confirmed to those already counted. `admitted` and `complete` keep the row; `timed-out` ends it.
 */
export function computeALOutboundReceiptAdmission(
    read: ALOutboundReceiptAdmissionRead
): ALOutboundReceiptAdmissionCandidate {
    const tracking = read.stored?.policy.ackTracking;
    if (!tracking) {
        return { read, write: undefined };
    }
    const expected = read.receipt.expectedRecipientPeerIds;
    const acked = new Set([...read.pending?.ackedPeerIds ?? [], ...read.receipt.confirmedRecipientPeerIds]);
    const value: ALOutboundPendingAckSnapshot = {
        msgId: read.receipt.msgId,
        mode: tracking.mode,
        expectedPeerIds: expected,
        ackedPeerIds: expected.filter((peerId) => acked.has(peerId)),
        timeoutMs: tracking.timeoutMs,
        maxAttempts: tracking.maxAttempts,
        attempts: read.pending?.attempts ?? 0,
        deadlineAtMs: read.pending?.deadlineAtMs ?? read.nowMs + tracking.timeoutMs
    };
    return { read, write: { kind: read.receipt.phase === 'timed-out' ? 'remove' : 'set', value } };
}

/** Every reason this receipt may not move the origin's receipt; an absent message makes the rest moot. */
export function validateALOutboundReceiptAdmission(
    candidate: ALOutboundReceiptAdmissionCandidate
): readonly ALMessageRejection[] {
    const { read, write } = candidate;
    if (!read.stored || read.stored.reference.senderId !== read.receipt.originPeerId) {
        return [refuseReceipt('AL receipt names no retained outbound message of its origin')];
    }
    const issues: ALMessageRejection[] = [];
    if (write === undefined || write.value.mode !== 'receiver') {
        issues.push(refuseReceipt('AL receipt names a message that tracks no receiver receipt'));
    }
    if (read.stored.reference.expiresAtMs <= read.nowMs) {
        issues.push(refuseReceipt('AL receipt arrived after its message deadline'));
    }
    if (write !== undefined && movesNoReceipt(read.pending, write)) {
        issues.push(refuseReceipt('AL receipt moves no receipt of its message'));
    }
    return issues;
}

/** A kept receipt expires with its message, as every pending receipt does. */
export function toALOutboundReceiptMutation(
    write: ALOutboundReceiptWrite,
    receipt: ALReceiptPayload,
    messageExpiresAtMs: number
): ALOutboundAdmissionMutation {
    return write.kind === 'remove'
        ? { kind: 'delete-pending-ack', originPeerId: receipt.originPeerId, msgId: receipt.msgId }
        : {
            kind: 'set-pending-ack',
            originPeerId: receipt.originPeerId,
            snapshot: write.value,
            expireAtTimestamp: messageExpiresAtMs
        };
}

/** The receipt as the delivery fact its commit states; only a `complete` aggregate completes it. */
export function toALOutboundReceiptSettlement(
    write: ALOutboundReceiptWrite,
    receipt: ALReceiptPayload
): ALOutboundSettlementFact {
    const { value } = write;
    return {
        kind: 'acknowledgement',
        msgId: value.msgId,
        mode: value.mode,
        confirmedHopPeerIds: value.ackedPeerIds,
        unconfirmedHopPeerIds: value.expectedPeerIds.filter((peerId) => !value.ackedPeerIds.includes(peerId)),
        complete: receipt.phase !== 'timed-out' && isALOutboundReceiptComplete(value)
    };
}

function movesNoReceipt(pending: ALOutboundPendingAckSnapshot | undefined, write: ALOutboundReceiptWrite): boolean {
    if (write.kind === 'remove') {
        return pending === undefined;
    }
    return pending !== undefined &&
        hasSamePeers(pending.expectedPeerIds, write.value.expectedPeerIds) &&
        hasSamePeers(pending.ackedPeerIds, write.value.ackedPeerIds);
}

function hasSamePeers(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((peerId) => right.includes(peerId));
}

function refuseReceipt(message: string): ALMessageRejection {
    return { code: 'unauthorized', message };
}
