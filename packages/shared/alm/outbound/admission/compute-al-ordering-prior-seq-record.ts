import type { ALOutboundSentPositions } from './al-outbound-admission-store.ts';
import type { ALStoredOutboundMessage } from './al-outbound-admission-validation.ts';

/**
 * The record a copy carries: each recipient last sent a sequence below `seq - 1` (`0` for one never sent the track).
 * A recipient last sent `seq - 1` reads its absence as that; one already at or past `seq` is a retry, not an exclusion.
 */
export function computeALOrderingPriorSeqRecord(positions: ALOutboundSentPositions): Readonly<Record<string, number>> {
    return Object.fromEntries(
        Object.entries(positions.priorSeqByRecipient).filter(([, priorSeq]) => priorSeq < positions.seq - 1)
    );
}

/**
 * Whether a row of a track still has to record its recipients' positions: a durable row this outbound admitted (its
 * canonical key names it) to an audience, unexpired and not yet recorded. Its successor on the track waits for it, so
 * positions are written in sequence order and "last sent" keeps its meaning (T3-R2).
 */
export function isALOutboundRowUnrecorded(stored: ALStoredOutboundMessage | undefined, nowMs: number): boolean {
    return stored !== undefined && stored.sentPositions === null && stored.policy.persist &&
        stored.policy.admittedAudience !== undefined && stored.reference.key.topicId === 'AL_OUTBOUND_MESSAGE' &&
        stored.reference.expiresAtMs > nowMs;
}
