import {
    isALHopCompletionAck,
    type ALAckPayload
} from '../../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../../al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../../al-contracts/al-message-resource-limits.ts';
import { isALRecipientConfirmationAck } from '../../delivery/is-al-recipient-confirmation-ack.ts';
import type { ALInboundControlAdmissionCandidate } from './compute-al-inbound-control-admission.ts';
import { hasALOutsideStatement, isALSameReceiptStatement } from './is-al-same-receipt-statement.ts';

/** Every reason this acknowledgement may not be admitted; an absent obligation makes the rest moot. */
export function validateALInboundControlAdmission(
    candidate: ALInboundControlAdmissionCandidate
): readonly ALMessageRejection[] {
    const { ack, pending, acks, nacks, owner } = candidate.read;
    if (!pending) {
        return [rejectInboundControl('Inbound acknowledgement sender has no pending obligation')];
    }
    const issues: ALMessageRejection[] = [];
    if (!pending.expectedFromPeerIds.includes(ack.fromPeerId)) {
        issues.push(rejectInboundControl('Inbound acknowledgement sender has no pending obligation'));
    }
    if (ack.originPeerId !== owner.senderId) {
        issues.push(
            rejectInboundControl('Inbound acknowledgement names another origin than the message it acknowledges')
        );
    }
    if (acks.some((prior) => isSameAckIdentity(prior, ack))) {
        issues.push(rejectInboundControl('Inbound acknowledgement was already admitted'));
    }
    if (isALRecipientConfirmationAck(ack) && hasALOutsideStatement(pending, { acks, nacks }, ack)) {
        issues.push(
            rejectInboundControl('Inbound acknowledgement names a recipient that answered it is not subscribed')
        );
    }
    if (
        candidate.acks.values.length > AL_MESSAGE_RESOURCE_LIMITS.collectionEntries ||
        !Number.isSafeInteger(candidate.controlExpireAtTimestamp) ||
        !Number.isSafeInteger(candidate.pendingExpireAtTimestamp)
    ) {
        issues.push(rejectInboundControl('Inbound acknowledgement candidate exceeds persistence limits'));
    }
    return issues;
}

/**
 * A recipient relay speaks for itself twice: `accepted` once it delivered, then its terminal ACK once its
 * subtree completed. Only the terminal one completes its hop, so the two never duplicate each other. A word a child
 * forwards for another recipient repeats only under its own proof: another proof is another statement.
 */
function isSameAckIdentity(prior: ALAckPayload, ack: ALAckPayload): boolean {
    return prior.fromPeerId === ack.fromPeerId && isALHopCompletionAck(prior) === isALHopCompletionAck(ack) &&
        isALSameReceiptStatement(prior, ack);
}

function rejectInboundControl(message: string): ALMessageRejection {
    return { code: 'unauthorized', message };
}
