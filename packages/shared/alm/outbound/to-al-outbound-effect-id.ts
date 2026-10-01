import type { ALOutboundPendingAckSnapshot } from '../al-runtime-state-stores.ts';

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
