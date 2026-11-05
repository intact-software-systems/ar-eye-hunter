import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { toALOrderingTrackKey } from '../../../al-contracts/al-runtime.ts';
import type { ALOutboundSentPositions } from './al-outbound-admission-store.ts';
import type { ALStoredOutboundMessage } from './al-outbound-admission-validation.ts';

/** The sequences one dequeued batch claimed, by track key. */
export type ALOrderingBatchSequences = ReadonlyMap<string, ReadonlySet<number>>;

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
 * Whether a durable row admitted to an audience still has to record its recipients' positions: unexpired and not yet
 * recorded. Its successor on the track waits for it, so positions are written in sequence order and "last sent" keeps
 * its meaning (T3-R2).
 */
export function isALOutboundRowUnrecorded(stored: ALStoredOutboundMessage, nowMs: number): boolean {
    return stored.sentPositions === null && stored.policy.persist && stored.policy.admittedAudience !== undefined &&
        stored.reference.expiresAtMs > nowMs;
}

/**
 * Whether a tracked row's predecessor (`seq - 1` of its track) is claimed in the same batch: the batch admits the two
 * in sequence order and chains their positions, so the row follows it there and is never held for it (T3-R5).
 */
export function isALOrderingPredecessorInBatch(message: ALMessage, batch: ALOrderingBatchSequences): boolean {
    const trackKey = toALOrderingTrackKey(message);
    const seq = message.ordering?.seq;
    return trackKey !== undefined && seq !== undefined && batch.get(trackKey)?.has(seq - 1) === true;
}

/** The sequences the messages claim, by track key; an untracked message claims none. */
export function toALOrderingBatchSequences(messages: readonly ALMessage[]): ALOrderingBatchSequences {
    const batch = new Map<string, Set<number>>();
    for (const message of messages) {
        const trackKey = toALOrderingTrackKey(message);
        const seq = message.ordering?.seq;
        if (trackKey !== undefined && seq !== undefined) {
            batch.set(trackKey, new Set([...(batch.get(trackKey) ?? []), seq]));
        }
    }
    return batch;
}
