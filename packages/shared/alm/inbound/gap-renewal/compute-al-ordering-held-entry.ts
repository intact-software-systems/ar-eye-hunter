import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALOrderingObservation, ALOrderingTrackSnapshot, ALSeqRange } from '../../../al-contracts/al-runtime.ts';
import { isALOrderingSnapshotLive, toALOrderingTrackKey } from '../../../al-contracts/al-runtime.ts';
import { computeALOrderingEntry } from '../../compute-al-ordering-observation.ts';
import {
    isALOrderingTrackStartOwed,
    type ALOrderingTrackStartInput
} from '../admission/is-al-ordering-track-start-owed.ts';

/** A gap timer's range, and the copy that revealed it with what that copy's plan says. */
export interface ALOrderingHeldStartRangeInput {
    readonly range: ALSeqRange;
    readonly start: ALOrderingTrackStartInput;
}

export interface ComputeALOrderingHeldEntryInput extends ALOrderingHeldStartRangeInput {
    /** The track as the store holds it. */
    readonly snapshot: ALOrderingTrackSnapshot | undefined;
    /** The track's buffered copies whose slots are still live, in sequence order. */
    readonly live: readonly ALMessage[];
    readonly nowMs: number;
    readonly trackTtlMs: number;
    /** Each buffered copy's own prior for this receiver, by its sequence; a copy without a record has none. */
    readonly bufferedPriorSeqs: Readonly<Record<number, number>>;
}

/**
 * Where a bounded hold ends its track: `entered` at the lowest live buffered copy, which with its contiguous live
 * successors is released, or `passed` when every buffered copy expired, releasing nothing.
 */
export type ALOrderingHeldEntry =
    | Readonly<{
        kind: 'entered';
        trackKey: string;
        /** The lowest live copy, which the track enters at. */
        msg: ALMessage;
        observation: ALOrderingObservation;
        nextSnapshot: ALOrderingTrackSnapshot;
    }>
    | Readonly<{ kind: 'passed'; trackKey: string; nextSnapshot: ALOrderingTrackSnapshot; }>;

/**
 * Whether a gap timer holds a track's start: the range `1..p` the first copy of a track revealed where its record owed
 * the recipient the start. That timer outlives its copy until the renewal schedule's last timer, so the hold always ends.
 */
export function isALOrderingHeldStartRange(input: ALOrderingHeldStartRangeInput): boolean {
    return input.range.from === 1 && isALOrderingTrackStartOwed(input.start);
}

/**
 * The bounded hold. When the start range's last renewal falls due unanswered on a track that has delivered nothing
 * (position `0`), the track passes every buffered sequence below its lowest live copy and enters at that copy,
 * releasing it and its contiguous live successors; with no live copy it passes every buffered sequence and releases
 * nothing, so its next copy follows in order. A copy below the new position that arrives later is stale, as at any
 * entry. `undefined`, keeping today's behaviour, for a track that delivered something or a timer that holds no start.
 */
export function computeALOrderingHeldEntry(input: ComputeALOrderingHeldEntryInput): ALOrderingHeldEntry | undefined {
    const trackKey = toALOrderingTrackKey(input.start.msg);
    const snapshot = isALOrderingSnapshotLive(input.snapshot, input.trackTtlMs, input.nowMs)
        ? input.snapshot
        : undefined;
    const passedSeq = snapshot?.bufferedSeqs.at(-1);
    if (
        trackKey === undefined || snapshot?.lastContiguousSeq !== 0 || passedSeq === undefined ||
        !isALOrderingHeldStartRange(input)
    ) {
        return undefined;
    }
    const [lowest, ...successors] = input.live;
    if (lowest === undefined) {
        return {
            kind: 'passed',
            trackKey,
            nextSnapshot: { lastContiguousSeq: passedSeq, bufferedSeqs: [], updatedAtMs: input.nowMs }
        };
    }
    const { observation, nextSnapshot } = computeALOrderingEntry({
        ...input.start,
        msg: lowest,
        snapshot: { ...snapshot, bufferedSeqs: successors.flatMap((copy) => copy.ordering?.seq ?? []) },
        nowMs: input.nowMs,
        trackTtlMs: input.trackTtlMs,
        bufferedPriorSeqs: input.bufferedPriorSeqs,
        apply: true,
        role: 'recipient'
    });
    return nextSnapshot === undefined || observation.seq === undefined ? undefined : {
        kind: 'entered',
        trackKey,
        msg: lowest,
        observation: { ...observation, releasableSeqs: [observation.seq, ...observation.releasableSeqs] },
        nextSnapshot
    };
}
