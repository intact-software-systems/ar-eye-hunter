import type { ALNackPayload, ALRepairPayload } from '../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import type { ALOutboundPendingAckSnapshot } from '../al-runtime-state-stores.ts';
import type { ALStoredOutboundMessage } from './al-outbound-admission-validation.ts';
import type {
    ALControlAdmissionCandidate,
    ALControlAdmissionRead
} from './compute-al-outbound-control-admission.ts';

export function validateALOutboundControlAdmission(
    candidate: ALControlAdmissionCandidate
): readonly ALMessageRejection[] {
    const { read } = candidate;
    if (!read.owner || !read.sent || read.sent.reference.senderId !== read.owner) {
        return [{ code: 'unauthorized', message: 'AL control has no retained outbound message obligation' }];
    }
    const issues: ALMessageRejection[] = [];
    if (
        candidate.nextVersion?.senderId !== read.owner ||
        !Number.isSafeInteger(candidate.nextVersion.version) ||
        candidate.nextVersion.version !== (read.ownerVersion?.version ?? 0) + 1
    ) {
        issues.push({ code: 'malformed', message: 'AL control version differs from its captured owner observation' });
    }
    if (read.parsed.payload.toPeerId !== read.owner) {
        issues.push({ code: 'unauthorized', message: 'AL control is addressed to another outbound message owner' });
    }
    if (isDuplicateControl(read)) {
        issues.push({ code: 'unauthorized', message: 'AL control was already admitted' });
    }
    if (read.parsed.type === 'ack') {
        const payload = read.parsed.payload;
        if (
            !read.pending || !read.pending.expectedPeerIds.includes(payload.fromPeerId) ||
            read.pending.ackedPeerIds.includes(payload.fromPeerId)
        ) {
            issues.push({
                code: 'unauthorized',
                message: 'AL acknowledgement sender has no pending outbound obligation'
            });
        }
        return issues;
    }
    const payload = read.parsed.payload;
    if (!isExpectedRepairPeer(read.sent, read.pending, payload.fromPeerId)) {
        issues.push({ code: 'unauthorized', message: 'AL repair sender has no retained outbound obligation' });
    }
    if (!hasValidOrderingHints(read.sent, payload)) {
        issues.push({
            code: 'unauthorized',
            message: 'AL repair ordering hints do not match the retained outbound message'
        });
    }
    return issues;
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
    sent: ALStoredOutboundMessage,
    pending: ALOutboundPendingAckSnapshot | undefined,
    peerId: string
): boolean {
    if (sent.unicastPeerId !== null) {
        return sent.unicastPeerId === peerId;
    }
    return pending?.expectedPeerIds.includes(peerId) === true;
}

function hasValidOrderingHints(
    sent: ALStoredOutboundMessage,
    payload: ALNackPayload | ALRepairPayload
): boolean {
    const missingSeqs = payload.missingSeqs ?? [];
    const hasHints = payload.orderingKey !== undefined || payload.expectedSeq !== undefined || missingSeqs.length > 0;
    if (!hasHints) {
        return true;
    }
    const trackKey = sent.orderingTrackKey;
    const triggerSeq = sent.orderingSeq;
    if (trackKey === null || triggerSeq === null || payload.orderingKey !== trackKey) {
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
