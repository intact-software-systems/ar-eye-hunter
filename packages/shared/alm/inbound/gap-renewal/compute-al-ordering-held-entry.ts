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
 * Where a bounded hold ends its track: `entered` at the lowest live buffered copy, which is released with every live
 * successor the run reaches past only expired copies, or `passed` when every buffered copy expired, releasing nothing.
 */
export type ALOrderingHeldEntry =
    | Readonly<{
        kind: 'entered';
        trackKey: string;
        /** The lowest live copy, which the track enters at. */
        msg: ALMessage;
        observation: ALOrderingObservation;
        nextSnapshot: ALOrderingTrackSnapshot;
        /** Each released copy reached past expired ones, by its sequence: the released copy it now follows. */
        passedPriorSeqs: Readonly<Record<number, number>>;
    }>
    | Readonly<{ kind: 'passed'; trackKey: string; nextSnapshot: ALOrderingTrackSnapshot; }>;

/**
 * Whether a gap timer holds a track's start: the range `1..p` the first copy of a track revealed where its record owed
 * the recipient the start. That timer lives for the track's ordering TTL, whatever its copy's lifetime, so the hold
 * always ends.
 */
export function isALOrderingHeldStartRange(input: ALOrderingHeldStartRangeInput): boolean {
    return input.range.from === 1 && isALOrderingTrackStartOwed(input.start);
}

/**
 * The bounded hold. When the start range's last renewal falls due unanswered on a track that has delivered nothing
 * (position `0`), the track passes every buffered sequence whose copy expired and enters at its lowest live copy,
 * releasing it and each live successor the run reaches across nothing but expired copies; with no live copy it passes
 * every buffered sequence and releases nothing, so its next copy follows in order. A copy below the new position that arrives later is stale, as at any
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
    const liveSeqs = input.live.flatMap((copy) => copy.ordering?.seq ?? []);
    const passed = computePassedPriorSeqs(liveSeqs, snapshot.bufferedSeqs);
    const { observation, nextSnapshot } = computeALOrderingEntry({
        ...input.start,
        msg: lowest,
        snapshot: { ...snapshot, bufferedSeqs: successors.flatMap((copy) => copy.ordering?.seq ?? []) },
        nowMs: input.nowMs,
        trackTtlMs: input.trackTtlMs,
        bufferedPriorSeqs: { ...input.bufferedPriorSeqs, ...passed },
        apply: true,
        role: 'recipient'
    });
    return nextSnapshot === undefined || observation.seq === undefined ? undefined : {
        kind: 'entered',
        trackKey,
        msg: lowest,
        observation: { ...observation, releasableSeqs: [observation.seq, ...observation.releasableSeqs] },
        nextSnapshot,
        passedPriorSeqs: Object.fromEntries(
            Object.entries(passed).filter(([seq]) => observation.releasableSeqs.includes(Number(seq)))
        )
    };
}

/** Each live copy whose every sequence back to the previous live copy is buffered and expired, by that copy's prior. */
function computePassedPriorSeqs(
    liveSeqs: readonly number[],
    bufferedSeqs: readonly number[]
): Readonly<Record<number, number>> {
    const buffered = new Set(bufferedSeqs);
    return Object.fromEntries(liveSeqs.flatMap((seq, index) => {
        const previous = liveSeqs[index - 1];
        const between = previous === undefined
            ? []
            : Array.from({ length: seq - previous - 1 }, (_, k) => previous + 1 + k);
        return between.length > 0 && between.every((missing) => buffered.has(missing)) ? [[seq, previous]] : [];
    }));
}
