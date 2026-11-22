import type { ALNackPayload } from '../../../al-contracts/al-control.ts';
import { resolveALFrozenMulticastAudience } from '../../../al-contracts/al-frozen-multicast-audience.ts';
import type { ALMessageRejection } from '../../../al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../../al-contracts/al-message-resource-limits.ts';
import { toALOrderingTrackKey } from '../../../al-contracts/al-runtime.ts';
import type {
    ALInboundNackAdmissionCandidate,
    ALInboundUnreceiptedGapNackAdmissionRead
} from './compute-al-inbound-nack-admission.ts';
import {
    hasALConfirmedStatement,
    hasALOutsideStatement,
    toALReceiptStatementHistory,
    toALReceiptStatementSubject
} from './is-al-same-receipt-statement.ts';

const MISSING_GAP_ORDERING_HINTS: ALMessageRejection = {
    code: 'malformed',
    message: 'Inbound gap NACK carries no ordering hints to forward'
};

/**
 * Every reason this NACK may not be forwarded: it must come from a child hop the row waits on and name a recipient of
 * the frozen audience the origin counts that no stored control of the same statement recorded outside or confirmed (PL9,
 * PL16, S8ii-R1). An outside-audience NACK must also fit the row's outside list and its NACK history; a gap NACK, which
 * writes no row, must carry the ordering hints it forwards.
 */
export function validateALInboundNackAdmission(
    candidate: ALInboundNackAdmissionCandidate
): readonly ALMessageRejection[] {
    const { nack, pending, acks, nacks, owner } = candidate.read;
    if (!pending) {
        return [rejectInboundNack('Inbound NACK sender has no pending obligation')];
    }
    const history = toALReceiptStatementHistory(acks, nacks);
    const subject = toALReceiptStatementSubject(nack);
    const issues: ALMessageRejection[] = [];
    if (!pending.expectedFromPeerIds.includes(nack.fromPeerId)) {
        issues.push(rejectInboundNack('Inbound NACK sender has no pending obligation'));
    }
    if (nack.originPeerId !== owner.senderId) {
        issues.push(rejectInboundNack('Inbound NACK names another origin than the message it answers'));
    }
    if (pending.upwardAudiencePeerIds?.includes(nack.logicalRecipientPeerId) !== true) {
        issues.push(rejectInboundNack('Inbound NACK names no recipient of the frozen audience'));
    }
    if (hasALOutsideStatement(pending, history, subject)) {
        issues.push(rejectInboundNack('Inbound NACK names a recipient already forwarded outside the audience'));
    }
    if (hasALConfirmedStatement(history.acks, subject)) {
        issues.push(rejectInboundNack('Inbound NACK names a recipient whose confirmation was already forwarded'));
    }
    if (nack.reason === 'gap' && !hasGapOrderingHints(nack)) {
        issues.push(MISSING_GAP_ORDERING_HINTS);
    }
    if (
        nack.reason !== 'gap' &&
        ((pending.outsideAudiencePeerIds.length >= AL_MESSAGE_RESOURCE_LIMITS.collectionEntries &&
            !pending.outsideAudiencePeerIds.includes(nack.logicalRecipientPeerId)) ||
            (candidate.nacks?.values.length ?? 0) > AL_MESSAGE_RESOURCE_LIMITS.collectionEntries ||
            !Number.isSafeInteger(candidate.controlExpireAtTimestamp) ||
            !Number.isSafeInteger(candidate.pendingExpireAtTimestamp))
    ) {
        issues.push(rejectInboundNack('Inbound NACK candidate exceeds persistence limits'));
    }
    return issues;
}

/**
 * Every reason a child's gap NACK about a message that asked for no receipt may not be forwarded without a row (6c): it
 * comes from a child, never the peer the message arrived from; it names a recipient of the message's frozen audience,
 * or, with none frozen, only the child itself; and it names the message's track with the hints the origin repairs by.
 */
export function validateALInboundUnreceiptedGapNackAdmission(
    read: ALInboundUnreceiptedGapNackAdmissionRead
): readonly ALMessageRejection[] {
    const { nack, msg } = read;
    const frozenPeerIds = resolveALFrozenMulticastAudience(msg.targets)?.recipientPeerIds;
    const issues: ALMessageRejection[] = [];
    if (nack.fromPeerId === read.parentPeerId) {
        issues.push(rejectInboundNack('Inbound NACK comes from the peer the message arrived from'));
    }
    if (frozenPeerIds !== undefined && !frozenPeerIds.includes(nack.logicalRecipientPeerId)) {
        issues.push(rejectInboundNack('Inbound NACK names no recipient of the frozen audience'));
    }
    if (frozenPeerIds === undefined && nack.logicalRecipientPeerId !== nack.fromPeerId) {
        issues.push(rejectInboundNack('Inbound NACK speaks for another recipient of a message that froze no audience'));
    }
    if (!hasGapOrderingHints(nack)) {
        issues.push(MISSING_GAP_ORDERING_HINTS);
    }
    else if (nack.orderingKey !== toALOrderingTrackKey(msg)) {
        issues.push(rejectInboundNack('Inbound NACK names a track the message is not on'));
    }
    return issues;
}

/** The recipient's track key, the sequence it expected and the ranges it misses, all of which the origin repairs by. */
function hasGapOrderingHints(nack: ALNackPayload): boolean {
    return nack.orderingKey !== undefined && nack.expectedSeq !== undefined && nack.missingRanges !== undefined;
}

function rejectInboundNack(message: string): ALMessageRejection {
    return { code: 'unauthorized', message };
}
