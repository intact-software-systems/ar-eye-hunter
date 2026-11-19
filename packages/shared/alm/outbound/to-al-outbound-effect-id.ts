import { toALSeqRangesText } from '../../al-contracts/al-seq-range.ts';
import type { ALOutboundPendingAckSnapshot } from '../al-runtime-state-stores.ts';
import type { ALOutboundRepairHint } from './admission/al-outbound-admission-store.ts';
import type { ALOutboundDispatchPhase } from './al-outbound-message-runtime.ts';
import type { ALOutboundCommitDispatchOptions } from './compute-al-outbound-dispatch.ts';
import type { ALOutboundFirstHopWaitSnapshot } from './first-hop/compute-al-outbound-first-hop-wait.ts';

/** What names one prepared copy's send: the attempt it belongs to and the copy's place and content in it. */
export interface ALOutboundSendEffectIdentity {
    readonly msgId: string;
    readonly phase: ALOutboundDispatchPhase;
    readonly attemptIdentity: string;
    readonly index: number;
    readonly preparedFingerprint: string;
}

export function toALOutboundEffectId(
    parts: readonly (number | string)[]
): string {
    return parts.map((part) => encodeURIComponent(String(part))).join(':');
}

/** The identity the sends of one dispatch carry: `initial` for a first send, its hint's for a repair. */
export function toALOutboundAttemptIdentity(options: Pick<ALOutboundCommitDispatchOptions, 'attemptIdentity'>): string {
    return options.attemptIdentity ?? 'initial';
}

/** The send of one prepared copy; a re-executed attempt names the same sends, which are written once. */
export function toALOutboundSendEffectId(identity: ALOutboundSendEffectIdentity): string {
    return toALOutboundEffectId([
        'send',
        identity.msgId,
        identity.phase,
        identity.attemptIdentity,
        identity.index,
        identity.preparedFingerprint
    ]);
}

/** The timeout check a receipt row schedules for its next attempt; the row's attempt and deadline name it. */
export function toALOutboundAckTimeoutEffectId(
    pending: Pick<ALOutboundPendingAckSnapshot, 'msgId' | 'attempts' | 'deadlineAtMs'>
): string {
    return toALOutboundEffectId(['ack-timeout', pending.msgId, pending.attempts + 1, pending.deadlineAtMs]);
}

/** The timeout check a first-hop wait schedules for its next attempt; the wait's attempt and deadline name it. */
export function toALOutboundFirstHopTimeoutEffectId(
    wait: Pick<ALOutboundFirstHopWaitSnapshot, 'msgId' | 'attempts' | 'deadlineAtMs'>
): string {
    return toALOutboundEffectId(['first-hop-timeout', wait.msgId, wait.attempts + 1, wait.deadlineAtMs]);
}

/**
 * The hint a NACK or repair request raises, and the follow-up that carries what a served page left. The
 * gap names it -- the requester, the track and the missing ranges, the recipient a relay asked for, and the
 * request's number -- never the control that reported it: a NACK and a repair request naming the same gap
 * with one number are one hint, served once, and so is the rest of one page. A later frame's report of the
 * same gap is a new hint, whose sequences name the attempt of their number by their gap identity. Per gap
 * means per (requester, track, sequence[, recipient], number): a page of N sequences is N attempt
 * identities. Each recipient a relay reports one gap for is its own hint; a hint without ranges carries
 * no number.
 */
export function toALOutboundRepairHintEffectId(msgId: string, request: ALOutboundRepairHint): string {
    return toALOutboundEffectId([
        'repair-hint',
        msgId,
        request.requestedByPeerId ?? '-',
        request.orderingTrackKey ?? '-',
        toALSeqRangesText(request.missingRanges),
        ...(request.logicalRecipientPeerId === undefined ? [] : [request.logicalRecipientPeerId]),
        ...(request.gapRequestNumber === undefined ? [] : [request.gapRequestNumber])
    ]);
}

/**
 * The attempt one paged sequence's repair belongs to: the gap names it -- the requester, the track, the
 * sequence, the recipient a relay asked for and the request's number -- so every later report of that gap
 * with the same number finds the attempt's sends and charges nothing more, while the next number is a new
 * attempt that writes the sequence again.
 */
export function toALOutboundRepairGapAttemptIdentity(
    request: ALOutboundRepairHint,
    trackKey: string,
    seq: number
): string {
    return toALOutboundEffectId([
        'repair-gap',
        request.requestedByPeerId ?? '-',
        trackKey,
        seq,
        ...(request.logicalRecipientPeerId === undefined ? [] : [request.logicalRecipientPeerId]),
        ...(request.gapRequestNumber === undefined ? [] : [request.gapRequestNumber])
    ]);
}

/** The requester a repair budget counts for: the peer that asks, and the recipient a relay asks for. */
export function toALOutboundRepairRequesterKey(
    request: Pick<ALOutboundRepairHint, 'requestedByPeerId' | 'logicalRecipientPeerId'>
): string {
    return toALOutboundEffectId([
        request.requestedByPeerId ?? '-',
        ...(request.logicalRecipientPeerId === undefined ? [] : [request.logicalRecipientPeerId])
    ]);
}
