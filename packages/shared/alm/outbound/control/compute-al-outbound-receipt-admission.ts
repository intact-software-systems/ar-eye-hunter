import type { ALReceiptPayload } from '../../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../../al-contracts/al-message-persistence-validation.ts';
import type { ALOutboundPendingAckSnapshot } from '../../al-runtime-state-stores.ts';
import type { ALOutboundAdmissionMutation } from '../admission/al-outbound-admission-mutations.ts';
import type { ALOutboundVersionedClientRecord } from '../admission/al-outbound-admission-store.ts';
import type { ALStoredOutboundMessage } from '../admission/al-outbound-admission-validation.ts';
import type { ALOutboundSettlementFact } from '../al-outbound-message-runtime.ts';
import { isALOutboundReceiptComplete } from '../transition-al-outbound-pending-ack.ts';

/**
 * How long the origin keeps a receipt row past its message deadline. The server sweeps an aggregate
 * at that deadline, so its `timed-out` receipt is written after it and still has to cross the cluster.
 */
export const AL_OUTBOUND_TERMINAL_RECEIPT_GRACE_MS = 30_000;

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
 * `set` keeps a row: the one a terminal receipt answers against, or the one a terminal receipt that
 * overtook its `admitted` receipt leaves so the late `admitted` moves nothing. `remove` ends the row,
 * and `settle` states the receipt without a row: an empty audience is complete as it is admitted.
 */
export type ALOutboundReceiptWrite =
    | Readonly<{ kind: 'set'; value: ALOutboundPendingAckSnapshot; expireAtTimestamp: number; }>
    | Readonly<{ kind: 'remove' | 'settle'; value: ALOutboundPendingAckSnapshot; }>;

export interface ALOutboundReceiptAdmissionCandidate {
    readonly read: ALOutboundReceiptAdmissionRead;
    /** Undefined when the receipt names nothing it could move: validation says why. */
    readonly write: ALOutboundReceiptWrite | undefined;
}

export function computeALOutboundReceiptAdmission(
    read: ALOutboundReceiptAdmissionRead
): ALOutboundReceiptAdmissionCandidate {
    return {
        read,
        write: read.receipt.phase === 'admitted' ? toAdmittedWrite(read) : toTerminalWrite(read)
    };
}

/** Every reason this receipt may not move the origin's receipt; a missing row or message makes the rest moot. */
export function validateALOutboundReceiptAdmission(
    candidate: ALOutboundReceiptAdmissionCandidate
): readonly ALMessageRejection[] {
    const { read, write } = candidate;
    if (read.receipt.phase !== 'admitted' && read.pending !== undefined) {
        return validateReceiptMode(read.pending);
    }
    if (!read.stored || read.stored.reference.senderId !== read.receipt.originPeerId) {
        return [refuseReceipt('AL receipt names no retained outbound message of its origin')];
    }
    const issues: ALMessageRejection[] = [];
    if (write === undefined) {
        issues.push(refuseReceipt('AL receipt names a message that tracks no receiver receipt'));
    }
    if (read.receipt.phase === 'admitted' && read.stored.reference.expiresAtMs <= read.nowMs) {
        issues.push(refuseReceipt('AL admitted receipt arrived after its message deadline'));
    }
    if (write?.kind === 'set' && read.pending !== undefined && hasSameReceipt(read.pending, write.value)) {
        issues.push(refuseReceipt('AL receipt moves no receipt of its message'));
    }
    return issues;
}

export function toALOutboundReceiptMutations(
    write: ALOutboundReceiptWrite,
    receipt: ALReceiptPayload
): readonly ALOutboundAdmissionMutation[] {
    switch (write.kind) {
        case 'set':
            return [{
                kind: 'set-pending-ack',
                originPeerId: receipt.originPeerId,
                snapshot: write.value,
                expireAtTimestamp: write.expireAtTimestamp
            }];
        case 'remove':
            return [{ kind: 'delete-pending-ack', originPeerId: receipt.originPeerId, msgId: receipt.msgId }];
        case 'settle':
            return [];
    }
}

/** The receipt as the delivery fact its commit states; a `timed-out` aggregate never completes it. */
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

/**
 * The server's receipts own this row's schedule: no `ack-timeout` work is written for it, and its
 * deadline is the message's. An empty audience settles complete without a row.
 */
function toAdmittedWrite(read: ALOutboundReceiptAdmissionRead): ALOutboundReceiptWrite | undefined {
    const tracking = read.stored?.policy.ackTracking;
    if (!read.stored || tracking?.mode !== 'receiver') {
        return undefined;
    }
    const expiresAtMs = read.stored.reference.expiresAtMs;
    const value: ALOutboundPendingAckSnapshot = {
        msgId: read.receipt.msgId,
        mode: tracking.mode,
        ...toReceiptPeers(read),
        timeoutMs: tracking.timeoutMs,
        maxAttempts: tracking.maxAttempts,
        attempts: read.pending?.attempts ?? 0,
        deadlineAtMs: expiresAtMs
    };
    return value.expectedPeerIds.length === 0
        ? { kind: 'settle', value }
        : { kind: 'set', value, expireAtTimestamp: expiresAtMs + AL_OUTBOUND_TERMINAL_RECEIPT_GRACE_MS };
}

/**
 * A terminal receipt answers against the row its `admitted` receipt created, and ends it. One that
 * overtook its `admitted` receipt keeps the row it would have ended, so the late `admitted` finds its
 * audience already answered.
 */
function toTerminalWrite(read: ALOutboundReceiptAdmissionRead): ALOutboundReceiptWrite | undefined {
    if (read.pending !== undefined) {
        return { kind: 'remove', value: { ...read.pending, ...toReceiptPeers(read) } };
    }
    return toAdmittedWrite(read);
}

function toReceiptPeers(
    read: ALOutboundReceiptAdmissionRead
): Pick<ALOutboundPendingAckSnapshot, 'expectedPeerIds' | 'ackedPeerIds'> {
    const expected = read.receipt.expectedRecipientPeerIds;
    const acked = new Set([...read.pending?.ackedPeerIds ?? [], ...read.receipt.confirmedRecipientPeerIds]);
    return { expectedPeerIds: expected, ackedPeerIds: expected.filter((peerId) => acked.has(peerId)) };
}

function validateReceiptMode(pending: ALOutboundPendingAckSnapshot): readonly ALMessageRejection[] {
    return pending.mode === 'receiver'
        ? []
        : [refuseReceipt('AL receipt names a message that tracks no receiver receipt')];
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
