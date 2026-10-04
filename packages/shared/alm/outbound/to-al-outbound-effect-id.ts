import { toALSeqRangesText } from '../../al-contracts/al-seq-range.ts';
import type { ALOutboundPendingAckSnapshot } from '../al-runtime-state-stores.ts';
import type { ALOutboundRepairHint } from './admission/al-outbound-admission-store.ts';

export function toALOutboundEffectId(
    parts: readonly (number | string)[]
): string {
    return parts.map((part) => encodeURIComponent(String(part))).join(':');
}

/** The timeout check a receipt row schedules for its next attempt; the row's attempt and deadline name it. */
export function toALOutboundAckTimeoutEffectId(
    pending: Pick<ALOutboundPendingAckSnapshot, 'msgId' | 'attempts' | 'deadlineAtMs'>
): string {
    return toALOutboundEffectId(['ack-timeout', pending.msgId, pending.attempts + 1, pending.deadlineAtMs]);
}

/**
 * The hint a NACK or repair request raises, and the follow-up that carries what a served page left: its
 * ranges name it, so the rest of one page and a later control naming the same gap are one hint, served once.
 */
export function toALOutboundRepairHintEffectId(msgId: string, request: ALOutboundRepairHint): string {
    return toALOutboundEffectId([
        'repair-hint',
        msgId,
        request.trigger,
        request.requestedByPeerId ?? '-',
        request.orderingTrackKey ?? '-',
        toALSeqRangesText(request.missingRanges)
    ]);
}
