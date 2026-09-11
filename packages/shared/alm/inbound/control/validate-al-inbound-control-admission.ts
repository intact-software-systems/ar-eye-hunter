import type { ALMessageRejection } from '../../../al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../../al-contracts/al-message-resource-limits.ts';
import type { ALInboundControlAdmissionCandidate } from './compute-al-inbound-control-admission.ts';

/** Every reason this acknowledgement may not be admitted; an absent obligation makes the rest moot. */
export function validateALInboundControlAdmission(
    candidate: ALInboundControlAdmissionCandidate
): readonly ALMessageRejection[] {
    const { ack, pending, acks } = candidate.read;
    if (!pending) {
        return [rejectInboundControl('Inbound acknowledgement sender has no pending obligation')];
    }
    const issues: ALMessageRejection[] = [];
    if (!pending.expectedFromPeerIds.includes(ack.fromPeerId)) {
        issues.push(rejectInboundControl('Inbound acknowledgement sender has no pending obligation'));
    }
    if (
        pending.ackedFromPeerIds.includes(ack.fromPeerId) ||
        acks.some((prior) => prior.fromPeerId === ack.fromPeerId)
    ) {
        issues.push(rejectInboundControl('Inbound acknowledgement was already admitted'));
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

function rejectInboundControl(message: string): ALMessageRejection {
    return { code: 'unauthorized', message };
}
