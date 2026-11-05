import type { ALOutboundSentPositions } from './al-outbound-admission-store.ts';

/**
 * The record a copy carries: each recipient never sent the track (`0`) or last sent a sequence below `seq - 1`. A
 * recipient last sent `seq - 1` reads its absence as that; one already at or past `seq` is a retry, not an exclusion.
 */
export function computeALOrderingPriorSeqRecord(positions: ALOutboundSentPositions): Readonly<Record<string, number>> {
    return Object.fromEntries(
        Object.entries(positions.priorSeqByRecipient).filter(([, priorSeq]) =>
            priorSeq === 0 || priorSeq < positions.seq - 1
        )
    );
}
