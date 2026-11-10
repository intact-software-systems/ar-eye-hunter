import type { ALMessageRejection } from '../../../al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../../al-contracts/al-message-resource-limits.ts';
import { isALRecipientConfirmationAck } from '../../delivery/is-al-recipient-confirmation-ack.ts';
import type { ALInboundNackAdmissionCandidate } from './compute-al-inbound-nack-admission.ts';
import { toALInboundUpwardNackOrdering } from './to-al-inbound-upward-control-work.ts';

/**
 * Every reason this NACK may not be relayed: it must come from a child hop the row waits on and name a recipient of
 * the frozen audience the origin counts that is neither outside nor confirmed (PL9, PL16). An outside-audience NACK
 * must also fit the row's outside list; a gap NACK, which writes no row, must carry the ordering hints it relays.
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
        issues.push(rejectInboundNack('Inbound NACK names a recipient whose confirmation was already relayed'));
    }
    if (nack.reason === 'gap' && toALInboundUpwardNackOrdering(nack) === undefined) {
        issues.push({ code: 'malformed', message: 'Inbound gap NACK carries no ordering hints to relay' });
    }
    if (
        nack.reason !== 'gap' &&
        (pending.outsideAudiencePeerIds.length >= AL_MESSAGE_RESOURCE_LIMITS.collectionEntries ||
            !Number.isSafeInteger(candidate.pendingExpireAtTimestamp))
    ) {
        issues.push(rejectInboundNack('Inbound NACK candidate exceeds persistence limits'));
    }
    return issues;
}

function rejectInboundNack(message: string): ALMessageRejection {
    return { code: 'unauthorized', message };
}
