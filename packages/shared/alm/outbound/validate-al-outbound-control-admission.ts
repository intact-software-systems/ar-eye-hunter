import type { ALAckPayload, ALNackPayload, ALRepairPayload } from '../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import type { ALSeqRange } from '../../al-contracts/al-runtime.ts';
import type { ALOutboundPendingAckSnapshot } from '../al-runtime-state-stores.ts';
import type { ALStoredOutboundMessage } from './admission/al-outbound-admission-validation.ts';
import type { ALControlAdmissionCandidate, ALControlAdmissionRead } from './compute-al-outbound-control-admission.ts';
import { resolveALOutboundRelayRejection } from './control/resolve-al-outbound-relay-rejection.ts';
import { toALOutboundAckedPeerId } from './transition-al-outbound-pending-ack.ts';

/** Every reason this control may not be admitted; an absent obligation makes the rest moot. */
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
        if (payload.originPeerId !== read.owner) {
            issues.push({
                code: 'unauthorized',
                message: 'AL acknowledgement names another origin than this outbound message owner'
            });
        }
        if (read.sent.reference.expiresAtMs <= read.nowMs) {
            issues.push({ code: 'unauthorized', message: 'AL acknowledgement arrived after its message deadline' });
        }
        return [...issues, ...validateAcknowledgedReceipt(read.pending, payload)];
    }
    const payload = read.parsed.payload;
    if (!isTrustedRelayRejection(read) && !isExpectedRepairPeer(read, payload.fromPeerId)) {
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

/**
 * An ACK must move its receipt: confirm a peer the receipt expects and has not counted yet. One that
 * would move nothing is refused rather than committed, so it costs no write and no version bump.
 */
function validateAcknowledgedReceipt(
    pending: ALOutboundPendingAckSnapshot | undefined,
    ack: ALAckPayload
): readonly ALMessageRejection[] {
    const countedPeerId = pending && toALOutboundAckedPeerId(pending.mode, ack);
    if (!pending || !countedPeerId || !pending.expectedPeerIds.includes(countedPeerId)) {
        return [{
            code: 'unauthorized',
            message: 'AL acknowledgement confirms no peer of the pending outbound receipt'
        }];
    }
    return pending.ackedPeerIds.includes(countedPeerId)
        ? [{ code: 'unauthorized', message: 'AL acknowledgement confirms a peer the receipt already counted' }]
        : [];
}

function isDuplicateControl(read: ALControlAdmissionRead): boolean {
    switch (read.parsed.type) {
        case 'ack': {
            const payload = read.parsed.payload;
            return read.history.kind === 'acks' &&
                read.history.values.some((prior) =>
                    prior.fromPeerId === payload.fromPeerId &&
                    prior.logicalRecipientPeerId === payload.logicalRecipientPeerId && prior.status === payload.status
                );
        }
        case 'nack': {
            const payload = read.parsed.payload;
            return read.history.kind === 'nacks' &&
                read.history.values.some((prior) =>
                    prior.fromPeerId === payload.fromPeerId && prior.reason === payload.reason &&
                    prior.orderingKey === payload.orderingKey && prior.expectedSeq === payload.expectedSeq &&
                    prior.serverSnapshotVersion === payload.serverSnapshotVersion &&
                    equalSeqRanges(prior.missingRanges, payload.missingRanges)
                );
        }
        case 'repair': {
            const payload = read.parsed.payload;
            return read.history.kind === 'repairs' &&
                read.history.values.some((prior) =>
                    prior.fromPeerId === payload.fromPeerId && prior.reason === payload.reason &&
                    prior.orderingKey === payload.orderingKey && prior.expectedSeq === payload.expectedSeq &&
                    equalSeqRanges(prior.missingRanges, payload.missingRanges)
                );
        }
    }
}

/**
 * The trusted server speaks for the relay it is, so its `resync-required` and `held-by-other` NACKs need no expected
 * peer, and neither does its `unauthorized`, `membership-fenced` or `no-leader` refusal of a message before any
 * receipt row exists.
 */
function isTrustedRelayRejection(read: ALControlAdmissionRead): boolean {
    return resolveALOutboundRelayRejection(read)?.relay === 'trusted-server';
}

/**
 * A repair or NACK comes from a unicast's addressee, from any peer its receipt expects, or from a hop the
 * composition sends every frame through: on WS, the server, tracked by the receipt or named by the client.
 */
function isExpectedRepairPeer(read: ALControlAdmissionRead, peerId: string): boolean {
    return read.sent?.unicastPeerId === peerId || read.pending?.expectedPeerIds.includes(peerId) === true ||
        read.hopPeerIds?.includes(peerId) === true;
}

function hasValidOrderingHints(
    sent: ALStoredOutboundMessage,
    payload: ALNackPayload | ALRepairPayload
): boolean {
    const missingRanges = payload.missingRanges ?? [];
    const hasHints = payload.orderingKey !== undefined || payload.expectedSeq !== undefined || missingRanges.length > 0;
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
    return missingRanges.every((range) =>
        range.to < triggerSeq && (payload.expectedSeq === undefined || range.from >= payload.expectedSeq)
    );
}

function equalSeqRanges(left: readonly ALSeqRange[] | undefined, right: readonly ALSeqRange[] | undefined): boolean {
    const leftRanges = left ?? [];
    const rightRanges = right ?? [];
    return leftRanges.length === rightRanges.length &&
        leftRanges.every((range, index) =>
            range.from === rightRanges[index].from && range.to === rightRanges[index].to
        );
}
