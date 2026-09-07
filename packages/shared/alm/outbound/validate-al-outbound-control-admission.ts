import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALNackPayload, ALRepairPayload } from '../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import { toALOrderingTrackKey } from '../../al-contracts/al-runtime.ts';
import { Either } from '../../resilience/Either.ts';
import type { ALOutboundPendingAckSnapshot } from '../al-runtime-state-stores.ts';
import type {
    ALControlAdmissionCandidate,
    ALControlAdmissionRead
} from './compute-al-outbound-control-admission.ts';

export function validateALOutboundControlAdmission(
    candidate: ALControlAdmissionCandidate
): Either<ALMessageRejection, ALControlAdmissionCandidate> {
    const { read } = candidate;
    if (!read.owner || !read.sent || read.sent.msg.id.senderId !== read.owner) {
        return rejectedControl('AL control has no retained outbound message obligation');
    }
    if (read.parsed.payload.toPeerId !== read.owner) {
        return rejectedControl('AL control is addressed to another outbound message owner');
    }
    if (isDuplicateControl(read)) {
        return rejectedControl('AL control was already admitted');
    }
    if (read.parsed.type === 'ack') {
        const payload = read.parsed.payload;
        if (
            !read.pending || !read.pending.expectedPeerIds.includes(payload.fromPeerId) ||
            read.pending.ackedPeerIds.includes(payload.fromPeerId)
        ) {
            return rejectedControl('AL acknowledgement sender has no pending outbound obligation');
        }
        return Either.ofRight(candidate);
    }
    const payload = read.parsed.payload;
    if (!isExpectedRepairPeer(read.sent.msg, read.pending, payload.fromPeerId)) {
        return rejectedControl('AL repair sender has no retained outbound obligation');
    }
    if (!hasValidOrderingHints(read.sent.msg, payload)) {
        return rejectedControl('AL repair ordering hints do not match the retained outbound message');
    }
    return Either.ofRight(candidate);
}

function rejectedControl(message: string): Either<ALMessageRejection, ALControlAdmissionCandidate> {
    return Either.ofLeft({ code: 'unauthorized', message });
}

function isDuplicateControl(read: ALControlAdmissionRead): boolean {
    switch (read.parsed.type) {
        case 'ack': {
            const payload = read.parsed.payload;
            return read.history.kind === 'acks' &&
                read.history.values.some((prior) =>
                    prior.fromPeerId === payload.fromPeerId && prior.status === payload.status
                );
        }
        case 'nack': {
            const payload = read.parsed.payload;
            return read.history.kind === 'nacks' &&
                read.history.values.some((prior) =>
                    prior.fromPeerId === payload.fromPeerId && prior.reason === payload.reason &&
                    prior.orderingKey === payload.orderingKey && prior.expectedSeq === payload.expectedSeq &&
                    prior.serverSnapshotVersion === payload.serverSnapshotVersion &&
                    equalNumbers(prior.missingSeqs, payload.missingSeqs)
                );
        }
        case 'repair': {
            const payload = read.parsed.payload;
            return read.history.kind === 'repairs' &&
                read.history.values.some((prior) =>
                    prior.fromPeerId === payload.fromPeerId && prior.reason === payload.reason &&
                    prior.orderingKey === payload.orderingKey && prior.expectedSeq === payload.expectedSeq &&
                    equalNumbers(prior.missingSeqs, payload.missingSeqs)
                );
        }
    }
}

function isExpectedRepairPeer(
    sent: ALMessage,
    pending: ALOutboundPendingAckSnapshot | undefined,
    peerId: string
): boolean {
    if (sent.targets?.mode === 'unicast') {
        return sent.targets.toPeerId === peerId;
    }
    return pending?.expectedPeerIds.includes(peerId) === true;
}

function hasValidOrderingHints(
    sent: ALMessage,
    payload: ALNackPayload | ALRepairPayload
): boolean {
    const missingSeqs = payload.missingSeqs ?? [];
    const hasHints = payload.orderingKey !== undefined || payload.expectedSeq !== undefined || missingSeqs.length > 0;
    if (!hasHints) {
        return true;
    }
    const trackKey = toALOrderingTrackKey(sent);
    const triggerSeq = sent.ordering?.seq;
    if (trackKey === undefined || triggerSeq === undefined || payload.orderingKey !== trackKey) {
        return false;
    }
    if (payload.expectedSeq !== undefined && payload.expectedSeq > triggerSeq) {
        return false;
    }
    return missingSeqs.every((seq) =>
        seq < triggerSeq && (payload.expectedSeq === undefined || seq >= payload.expectedSeq)
    );
}

function equalNumbers(left: readonly number[] | undefined, right: readonly number[] | undefined): boolean {
    const leftValues = left ?? [];
    const rightValues = right ?? [];
    return leftValues.length === rightValues.length && leftValues.every((value, index) => value === rightValues[index]);
}
