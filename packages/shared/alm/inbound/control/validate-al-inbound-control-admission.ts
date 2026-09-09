import type { ALMessageRejection } from '../../../al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../../al-contracts/al-message-resource-limits.ts';
import { Either } from '../../../resilience/Either.ts';
import type { ALInboundControlAdmissionCandidate } from './compute-al-inbound-control-admission.ts';

export function validateALInboundControlAdmission(
    candidate: ALInboundControlAdmissionCandidate
): Either<ALMessageRejection, ALInboundControlAdmissionCandidate> {
    const { ack, pending, acks } = candidate.read;
    if (!pending || !pending.expectedFromPeerIds.includes(ack.fromPeerId)) {
        return rejectInboundControl('Inbound acknowledgement sender has no pending obligation');
    }
    if (
        pending.ackedFromPeerIds.includes(ack.fromPeerId) ||
        acks.some((prior) => prior.fromPeerId === ack.fromPeerId)
    ) {
        return rejectInboundControl('Inbound acknowledgement was already admitted');
    }
    if (
        candidate.acks.values.length > AL_MESSAGE_RESOURCE_LIMITS.collectionEntries ||
        !Number.isSafeInteger(candidate.controlExpireAtTimestamp) ||
        !Number.isSafeInteger(candidate.pendingExpireAtTimestamp)
    ) {
        return rejectInboundControl('Inbound acknowledgement candidate exceeds persistence limits');
    }
    return Either.ofRight(candidate);
}

function rejectInboundControl(
    message: string
): Either<ALMessageRejection, ALInboundControlAdmissionCandidate> {
    return Either.ofLeft({ code: 'unauthorized', message });
}
