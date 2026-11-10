import type { ALNackPayload } from '../../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../../al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../../al-contracts/al-message-resource-limits.ts';
import { isALRecipientConfirmationAck } from '../../delivery/is-al-recipient-confirmation-ack.ts';
import type { ALInboundNackAdmissionCandidate } from './compute-al-inbound-nack-admission.ts';

/**
 * Every reason this NACK may not be forwarded: it must come from a child hop the row waits on and name a recipient of
 * the frozen audience the origin counts that is neither outside nor confirmed (PL9, PL16). An outside-audience NACK
 * must also fit the row's outside list and its NACK history; a gap NACK, which writes no row, must carry the ordering
 * hints it forwards.
 */
export function validateALInboundNackAdmission(
    candidate: ALInboundNackAdmissionCandidate
): readonly ALMessageRejection[] {
    const { nack, pending, acks, owner } = candidate.read;
    if (!pending) {
        return [rejectInboundNack('Inbound NACK sender has no pending obligation')];
    }
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
    if (pending.outsideAudiencePeerIds.includes(nack.logicalRecipientPeerId)) {
        issues.push(rejectInboundNack('Inbound NACK names a recipient already relayed outside the audience'));
    }
    if (
        acks.some((ack) =>
            ack.logicalRecipientPeerId === nack.logicalRecipientPeerId && isALRecipientConfirmationAck(ack)
        )
    ) {
        issues.push(rejectInboundNack('Inbound NACK names a recipient whose confirmation was already forwarded'));
    }
    if (nack.reason === 'gap' && !hasGapOrderingHints(nack)) {
        issues.push({ code: 'malformed', message: 'Inbound gap NACK carries no ordering hints to relay' });
    }
    if (
        nack.reason !== 'gap' &&
        (pending.outsideAudiencePeerIds.length >= AL_MESSAGE_RESOURCE_LIMITS.collectionEntries ||
            (candidate.nacks?.values.length ?? 0) > AL_MESSAGE_RESOURCE_LIMITS.collectionEntries ||
            !Number.isSafeInteger(candidate.controlExpireAtTimestamp) ||
            !Number.isSafeInteger(candidate.pendingExpireAtTimestamp))
    ) {
        issues.push(rejectInboundNack('Inbound NACK candidate exceeds persistence limits'));
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
