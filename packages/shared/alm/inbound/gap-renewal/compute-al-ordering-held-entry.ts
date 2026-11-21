import type { ALOrderingObservation, ALOrderingTrackSnapshot } from '../../../al-contracts/al-runtime.ts';
import { isALOrderingSnapshotLive } from '../../../al-contracts/al-runtime.ts';
import {
    computeALOrderingEntry,
    type ComputeALOrderingObservationInput
} from '../../compute-al-ordering-observation.ts';
import { isALOrderingTrackStartOwed } from '../admission/is-al-ordering-track-start-owed.ts';

/** A track's lowest buffered copy when its last gap renewal fell due unanswered, and what its plan says. */
export type ComputeALOrderingHeldEntryInput = Pick<
    ComputeALOrderingObservationInput,
    'snapshot' | 'msg' | 'nowMs' | 'trackTtlMs' | 'selfPeerId' | 'bufferedPriorSeqs' | 'latestWins' | 'repairsGaps'
>;

/** Where a bounded hold enters its track: the entry observed at the lowest copy, and the position it moves to. */
export interface ALOrderingHeldEntry {
    readonly trackKey: string;
    readonly observation: ALOrderingObservation;
    readonly nextSnapshot: ALOrderingTrackSnapshot;
}

/**
 * The bounded hold. A track opened at its start that has delivered nothing (position `0`) enters at its lowest buffered
 * copy once its last gap renewal fell due unanswered: the copy and its contiguous successors are released, and a copy
 * below the new position that arrives later is stale, as it is at any entry. `undefined`, keeping today's behaviour,
 * for a track that delivered something, a copy that is not its lowest buffered one, or one whose record owes no start.
 */
export function computeALOrderingHeldEntry(input: ComputeALOrderingHeldEntryInput): ALOrderingHeldEntry | undefined {
    const seq = input.msg.ordering?.seq;
    const snapshot = isALOrderingSnapshotLive(input.snapshot, input.trackTtlMs, input.nowMs)
        ? input.snapshot
        : undefined;
    if (
        snapshot?.lastContiguousSeq !== 0 || snapshot.bufferedSeqs[0] !== seq ||
        !isALOrderingTrackStartOwed({ ...input, evictedTrack: false })
    ) {
        return undefined;
    }
    const { observation, nextSnapshot } = computeALOrderingEntry({
        ...input,
        snapshot: { ...snapshot, bufferedSeqs: snapshot.bufferedSeqs.slice(1) },
        apply: true,
        role: 'recipient',
        evictedTrack: false
    });
    const trackKey = observation.trackKey;
    return trackKey === undefined || nextSnapshot === undefined ? undefined : {
        trackKey,
        observation: { ...observation, releasableSeqs: [seq, ...observation.releasableSeqs] },
        nextSnapshot
    };
}
