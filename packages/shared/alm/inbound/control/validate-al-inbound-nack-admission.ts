import type { ALNackPayload } from '../../../al-contracts/al-control.ts';
import { resolveALFrozenMulticastAudience } from '../../../al-contracts/al-frozen-multicast-audience.ts';
import type { ALMessageRejection } from '../../../al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../../al-contracts/al-message-resource-limits.ts';
import { toALOrderingTrackKey } from '../../../al-contracts/al-runtime.ts';
import type {
    ALInboundNackAdmissionCandidate,
    ALInboundUnheldGapNackAdmissionRead,
    ALInboundUnreceiptedGapNackAdmissionRead
} from './compute-al-inbound-nack-admission.ts';
import {
    hasALConfirmedStatement,
    hasALOutsideStatement,
    toALReceiptStatementHistory,
    toALReceiptStatementSubject
} from './is-al-same-receipt-statement.ts';

const OUTSIDE_FROZEN_AUDIENCE: ALMessageRejection = {
    code: 'unauthorized',
    message: 'Inbound NACK names no recipient of the frozen audience'
};

const MISSING_GAP_ORDERING_HINTS: ALMessageRejection = {
    code: 'malformed',
    message: 'Inbound gap NACK carries no ordering hints to forward'
};

const NO_RELAY_HOP_LEFT: ALMessageRejection = {
    code: 'unauthorized',
    message: 'Inbound gap NACK has no relay hop left'
};

const SPEAKS_FOR_RELAY: ALMessageRejection = {
    code: 'unauthorized',
    message: 'Inbound gap NACK speaks for this relay itself'
};

/**
 * Every reason this NACK may not be forwarded: it must come from a child hop the row waits on, or from a child the
 * accepted layout of the message's room names (6d), and name a recipient of the frozen audience the origin counts that
 * no stored control of the same statement recorded outside or confirmed (PL9, PL16, S8ii-R1). An outside-audience NACK
 * must also fit the row's outside list and its NACK history; a gap NACK, which writes no row, must carry the ordering
 * hints it forwards and a relay hop to spend, and speak for another recipient than this relay.
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
    const isLayoutChild = candidate.read.gapRoute?.isLayoutChild === true;
    if (!isALInboundRelayChild(nack.fromPeerId, pending.expectedFromPeerIds, isLayoutChild)) {
        issues.push(rejectInboundNack('Inbound NACK sender has no pending obligation'));
    }
    if (nack.originPeerId !== owner.senderId) {
        issues.push(rejectInboundNack('Inbound NACK names another origin than the message it answers'));
    }
    if (pending.upwardAudiencePeerIds?.includes(nack.logicalRecipientPeerId) !== true) {
        issues.push(OUTSIDE_FROZEN_AUDIENCE);
    }
    if (hasALOutsideStatement(pending, history, subject)) {
        issues.push(rejectInboundNack('Inbound NACK names a recipient already forwarded outside the audience'));
    }
    if (hasALConfirmedStatement(history.acks, subject)) {
        issues.push(rejectInboundNack('Inbound NACK names a recipient whose confirmation was already forwarded'));
    }
    if (nack.reason === 'gap') {
        issues.push(
            ...(hasGapOrderingHints(nack) ? [] : [MISSING_GAP_ORDERING_HINTS]),
            ...validateALInboundGapNackHop(nack)
        );
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
 * A relay's child, on the row path and on 6c: a peer the plan its copy went down named (the hops its row waits on, or
 * the next hops it passes a retried copy to), or one the accepted layout of the message's room names below it (6d).
 */
export function isALInboundRelayChild(
    fromPeerId: string,
    plannedChildPeerIds: readonly string[],
    isLayoutChild: boolean
): boolean {
    return plannedChildPeerIds.includes(fromPeerId) || isLayoutChild;
}

/**
 * Every reason a child's gap NACK about a message that asked for no receipt may not be forwarded without a row (6c): it
 * comes from a child of this relay (one it forwards the message to, or one its accepted layout names), never the peer
 * the message arrived from; it names a recipient of the message's frozen audience, when one is frozen; it names the
 * message's track with the hints the origin repairs by; and it has a relay hop to spend and speaks for another
 * recipient than this relay. Whom a NACK about a message that froze no audience speaks for the origin judges, by the
 * recipient's signature.
 */
export function validateALInboundUnreceiptedGapNackAdmission(
    read: ALInboundUnreceiptedGapNackAdmissionRead
): readonly ALMessageRejection[] {
    const { nack, msg } = read;
    const frozenPeerIds = resolveALFrozenMulticastAudience(msg.targets)?.recipientPeerIds;
    const issues: ALMessageRejection[] = [];
    if (nack.fromPeerId === read.arrivalPeerId) {
        issues.push(rejectInboundNack('Inbound NACK comes from the peer the message arrived from'));
    }
    if (!isALInboundRelayChild(nack.fromPeerId, read.childPeerIds, read.route.isLayoutChild)) {
        issues.push(rejectInboundNack('Inbound NACK comes from no child this relay forwards the message to'));
    }
    if (frozenPeerIds !== undefined && !frozenPeerIds.includes(nack.logicalRecipientPeerId)) {
        issues.push(OUTSIDE_FROZEN_AUDIENCE);
    }
    if (!hasGapOrderingHints(nack)) {
        issues.push(MISSING_GAP_ORDERING_HINTS);
    }
    else if (nack.orderingKey !== toALOrderingTrackKey(msg)) {
        issues.push(rejectInboundNack('Inbound NACK names a track the message is not on'));
    }
    return [...issues, ...validateALInboundGapNackHop(nack)];
}

/**
 * Every reason a child's gap NACK about a message this relay holds nothing of may not be forwarded (6d): it carries the
 * ordering hints the origin repairs by, a relay hop to spend, and speaks for another recipient than this relay. The
 * lane named this relay's parent only for a sender that is its child in its accepted layout; whom it speaks for the
 * origin judges, by the recipient's signature or its receipt.
 */
export function validateALInboundUnheldGapNackAdmission(
    read: ALInboundUnheldGapNackAdmissionRead
): readonly ALMessageRejection[] {
    return [
        ...(hasGapOrderingHints(read.nack) ? [] : [MISSING_GAP_ORDERING_HINTS]),
        ...validateALInboundGapNackHop(read.nack)
    ];
}

/**
 * Every relay spends one of a gap NACK's relay hops, so a NACK relays whose accepted layouts disagree pass round a cycle
 * stops once its leaf's grant is spent. A NACK that speaks for this relay is its own report come back round such a
 * cycle: the relay's own reports leave from its gap run, never from this admission.
 */
function validateALInboundGapNackHop(nack: ALNackPayload): readonly ALMessageRejection[] {
    return [
        ...(nack.relayHopsLeft === 0 ? [NO_RELAY_HOP_LEFT] : []),
        ...(nack.logicalRecipientPeerId === nack.toPeerId ? [SPEAKS_FOR_RELAY] : [])
    ];
}

/** The recipient's track key, the sequence it expected and the ranges it misses, all of which the origin repairs by. */
function hasGapOrderingHints(nack: ALNackPayload): boolean {
    return nack.orderingKey !== undefined && nack.expectedSeq !== undefined && nack.missingRanges !== undefined;
}

function rejectInboundNack(message: string): ALMessageRejection {
    return { code: 'unauthorized', message };
}
