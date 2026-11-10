import {
    isALHopCompletionAck,
    type ALAckPayload,
    type ALNackPayload,
    type ALPeerRepairControlMessage,
    type ALRepairPayload
} from '../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import type { ALSeqRange } from '../../al-contracts/al-runtime.ts';
import { isALImpliedNotSubscribedNack } from '../delivery/is-al-implied-not-subscribed-nack.ts';
import { isALOutsideAudienceNackReason } from '../delivery/is-al-outside-audience-nack-reason.ts';
import type { ALStoredOutboundMessage } from './admission/al-outbound-admission-validation.ts';
import type { ALControlAdmissionCandidate, ALControlAdmissionRead } from './compute-al-outbound-control-admission.ts';
import {
    isALOutboundExpectedRepairPeer,
    isALOutboundRecipientControlSender
} from './control/is-al-outbound-expected-repair-peer.ts';
import { isALOutboundRelayedGapNack } from './control/is-al-outbound-relayed-gap-nack.ts';
import { resolveALOutboundRelayRejection } from './control/resolve-al-outbound-relay-rejection.ts';
import { toALOutboundReceiptClasses } from './control/to-al-outbound-receipt-classes.ts';
import { validateALOutboundOutsideAudienceNack } from './control/validate-al-outbound-outside-audience-nack.ts';
import { validateALOutboundRelayedNack } from './control/validate-al-outbound-relayed-nack.ts';
import { toALOutboundAckedPeerId, toALOutboundCompletedHopPeerIds } from './transition-al-outbound-pending-ack.ts';

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
    if (read.parsed.type === 'nack' && read.parsed.payload.originPeerId !== read.owner) {
        issues.push({ code: 'unauthorized', message: 'AL NACK names another origin than this outbound message owner' });
    }
    if (isDuplicateControl(read)) {
        issues.push({ code: 'unauthorized', message: 'AL control was already admitted' });
    }
    if (read.parsed.type === 'ack') {
        return [...issues, ...validateAcknowledgement(read, read.sent, read.parsed.payload)];
    }
    if (read.parsed.type === 'nack' && isALOutsideAudienceNackReason(read.parsed.payload.reason)) {
        return [...issues, ...validateALOutboundOutsideAudienceNack(read, read.parsed.payload)];
    }
    return [...issues, ...validateRepairRequest(read, read.sent, read.parsed)];
}

/** An ACK names this owner as its origin, arrives before the message's deadline and moves the receipt. */
function validateAcknowledgement(
    read: ALControlAdmissionRead,
    sent: ALStoredOutboundMessage,
    ack: ALAckPayload
): readonly ALMessageRejection[] {
    const issues: ALMessageRejection[] = [];
    if (ack.originPeerId !== read.owner) {
        issues.push({
            code: 'unauthorized',
            message: 'AL acknowledgement names another origin than this outbound message owner'
        });
    }
    if (sent.reference.expiresAtMs <= read.nowMs) {
        issues.push({ code: 'unauthorized', message: 'AL acknowledgement arrived after its message deadline' });
    }
    return [...issues, ...validateAcknowledgedReceipt(read, ack)];
}

/**
 * Any other NACK, and a repair request, comes from a peer a repair may come from; a gap NACK a relay re-sends for a
 * recipient below it comes from a next hop and names a recipient the receipt still owes, as an outside-audience NACK
 * does (S4ii-R3). Its ordering hints name the retained message's track.
 */
function validateRepairRequest(
    read: ALControlAdmissionRead,
    sent: ALStoredOutboundMessage,
    control: ALPeerRepairControlMessage
): readonly ALMessageRejection[] {
    const issues: ALMessageRejection[] = [];
    if (isALOutboundRelayedGapNack(control)) {
        issues.push(...validateALOutboundRelayedNack(read, control.payload));
    }
    else if (!isTrustedRelayRejection(read) && !isALOutboundExpectedRepairPeer(read, control.payload.fromPeerId)) {
        issues.push({ code: 'unauthorized', message: 'AL repair sender has no retained outbound obligation' });
    }
    if (!hasValidOrderingHints(sent, control.payload)) {
        issues.push({
            code: 'unauthorized',
            message: 'AL repair ordering hints do not match the retained outbound message'
        });
    }
    return issues;
}

/**
 * An ACK must move its receipt: confirm a peer the receipt expects and has not counted yet. One that
 * would move nothing is refused rather than committed, so it costs no write and no version bump. The
 * exception is the terminal ACK of a next hop whose recipient the receipt already counted, or which confirms
 * nobody, having answered `not-subscribed`: it completes that hop, which the hop view records, so a retry never
 * resends into its subtree. A hop-end that confirms nobody, which a relay forwards for a recipient the receipt still
 * owes, moves that recipient outside the audience when it comes from a peer a relayed NACK may come from.
 */
function validateAcknowledgedReceipt(read: ALControlAdmissionRead, ack: ALAckPayload): readonly ALMessageRejection[] {
    const pending = read.pending;
    const countedPeerId = pending && toALOutboundAckedPeerId(pending.mode, ack);
    if (
        pending && countedPeerId === undefined &&
        (isOpenNextHopCompletion(read, ack) || isForwardedOutsideHopEnd(read, pending, ack))
    ) {
        return [];
    }
    if (
        !pending || !countedPeerId || !pending.expectedPeerIds.includes(countedPeerId) ||
        pending.outsideAudiencePeerIds.includes(countedPeerId)
    ) {
        return [{
            code: 'unauthorized',
            message: 'AL acknowledgement confirms no peer of the pending outbound receipt'
        }];
    }
    return pending.ackedPeerIds.includes(countedPeerId) && !isOpenNextHopCompletion(read, ack)
        ? [{ code: 'unauthorized', message: 'AL acknowledgement confirms a peer the receipt already counted' }]
        : [];
}

function isForwardedOutsideHopEnd(
    read: ALControlAdmissionRead,
    pending: NonNullable<ALControlAdmissionRead['pending']>,
    ack: ALAckPayload
): boolean {
    return isALOutboundRecipientControlSender(read, ack.fromPeerId) &&
        isALImpliedNotSubscribedNack(ack, toALOutboundReceiptClasses(pending).unconfirmedPeerIds);
}

function isOpenNextHopCompletion(read: ALControlAdmissionRead, ack: ALAckPayload): boolean {
    const completedHopPeerIds = toALOutboundCompletedHopPeerIds(
        read.history.kind === 'acks' ? read.history.values : []
    );
    return isALHopCompletionAck(ack) &&
        read.sent?.policy.ackTracking?.nextHopPeerIds.includes(ack.fromPeerId) === true &&
        !completedHopPeerIds.includes(ack.fromPeerId);
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
                    prior.logicalRecipientPeerId === payload.logicalRecipientPeerId &&
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
 * The trusted server speaks for the relay it is, so its `resync-required`, `held-by-other`, `unsupported` and
 * `no-publish-grant` NACKs need no expected peer, and neither does its `unauthorized`, `membership-fenced` or
 * `no-leader` refusal of a message before any receipt row exists.
 */
function isTrustedRelayRejection(read: ALControlAdmissionRead): boolean {
    return resolveALOutboundRelayRejection(read)?.relay === 'trusted-server';
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
