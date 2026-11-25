import type { PersistedALRecord } from '../../al-contracts/al-message-persistence/persisted-al-value-validation.ts';
import { toALSeqRangesText } from '../../al-contracts/al-seq-range.ts';
import type { ALOutboundPendingAckSnapshot } from '../al-runtime-state-stores.ts';
import type { ALOutboundRepairHint, ALOutboundSendAttemptIdentity } from './admission/al-outbound-admission-store.ts';
import type { ALOutboundDispatchPhase } from './al-outbound-message-runtime.ts';
import type { ALOutboundCommitDispatchOptions } from './compute-al-outbound-dispatch.ts';
import type { ALOutboundFirstHopWaitSnapshot } from './first-hop/compute-al-outbound-first-hop-wait.ts';
import { toALOutboundPreparedFingerprint } from './to-al-outbound-prepared-fingerprint.ts';

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

/** One attempt of a message, with the copies the message is planned with. */
export interface ALOutboundPlannedSendAttempt<TPrepared> extends ALOutboundSendAttemptIdentity {
    readonly msgId: string;
    readonly preparedMessages: readonly TPrepared[];
}

/** The sends of one attempt: one per copy the message is planned with, named by the copy's place and content. */
export function toALOutboundAttemptSendEffectIds<TPrepared>(
    attempt: ALOutboundPlannedSendAttempt<TPrepared>
): readonly string[] {
    return attempt.preparedMessages.map((prepared, index) =>
        toALOutboundSendEffectId({
            msgId: attempt.msgId,
            phase: attempt.phase,
            attemptIdentity: attempt.attemptIdentity,
            index,
            preparedFingerprint: toALOutboundPreparedFingerprint(prepared)
        })
    );
}

/** A persisted record's attempt: a non-empty identity and the phase of a dispatch; `label` names the row in the error. */
export function decodeALOutboundSendAttemptIdentity(
    fields: PersistedALRecord,
    label: string
): ALOutboundSendAttemptIdentity {
    const { attemptIdentity, phase } = fields;
    if (typeof attemptIdentity !== 'string' || attemptIdentity.length === 0) {
        throw new TypeError(`Persisted AL ${label} attempt identity is invalid`);
    }
    if (phase !== 'immediate' && phase !== 'dequeue') {
        throw new TypeError(`Persisted AL ${label} phase is invalid`);
    }
    return { attemptIdentity, phase };
}

/** The timeout check a receipt row schedules for its next attempt; the row's attempt and deadline name it. */
export function toALOutboundAckTimeoutEffectId(
    pending: Pick<ALOutboundPendingAckSnapshot, 'msgId' | 'attempts' | 'deadlineAtMs'>
): string {
    return toALOutboundEffectId(['ack-timeout', pending.msgId, pending.attempts + 1, pending.deadlineAtMs]);
}

/** The one end of a message retained as work: a second retain of it is absorbed by the row the first wrote. */
export function toALOutboundEndMessageEffectId(msgId: string): string {
    return toALOutboundEffectId(['end-message', msgId]);
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

/**
 * The requester a repair budget counts for: the receiver that misses the sequence -- the recipient a relay
 * asks for, else the peer that asks. A hop that carries a receiver's request earns it no second budget.
 */
export function toALOutboundRepairRequesterKey(
    request: Pick<ALOutboundRepairHint, 'requestedByPeerId' | 'logicalRecipientPeerId'>
): string {
    return toALOutboundEffectId([request.logicalRecipientPeerId ?? request.requestedByPeerId ?? '-']);
}
