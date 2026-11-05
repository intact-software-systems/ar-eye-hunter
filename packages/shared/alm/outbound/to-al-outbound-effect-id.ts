import { toALSeqRangesText } from '../../al-contracts/al-seq-range.ts';
import type { ALOutboundPendingAckSnapshot } from '../al-runtime-state-stores.ts';
import type { ALOutboundRepairHint } from './admission/al-outbound-admission-store.ts';
import type { ALOutboundDispatchPhase } from './al-outbound-message-runtime.ts';

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

/**
 * The hint a NACK or repair request raises, and the follow-up that carries what a served page left. The
 * gap names it -- the requester, the track and the missing ranges, and the recipient a relay asked for --
 * never the control that reported it: a NACK and a repair request naming the same gap are one hint, served
 * once, and so are the rest of one page and a later report of the same gap. Each recipient a relay reports
 * one gap for is its own hint; a hint without a recipient keeps the identity it always had.
 */
export function toALOutboundRepairHintEffectId(msgId: string, request: ALOutboundRepairHint): string {
    return toALOutboundEffectId([
        'repair-hint',
        msgId,
        request.requestedByPeerId ?? '-',
        request.orderingTrackKey ?? '-',
        toALSeqRangesText(request.missingRanges),
        ...(request.logicalRecipientPeerId === undefined ? [] : [request.logicalRecipientPeerId])
    ]);
}
