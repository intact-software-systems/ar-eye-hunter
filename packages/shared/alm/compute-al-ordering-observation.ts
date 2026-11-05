import type { ALMessage } from '../al-contracts/al-contract.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../al-contracts/al-message-resource-limits.ts';
import type {
    ALOrderingObservation,
    ALOrderingObserverRole,
    ALOrderingTrackSnapshot,
    ALSeqRange
} from '../al-contracts/al-runtime.ts';
import { toALOrderingTrackKey } from '../al-contracts/al-runtime.ts';

export interface ComputeALOrderingObservationInput {
    readonly snapshot: ALOrderingTrackSnapshot | undefined;
    readonly msg: ALMessage;
    readonly nowMs: number;
    readonly trackTtlMs: number;
    readonly apply: boolean;
    readonly role: ALOrderingObserverRole;
    readonly selfPeerId: string;
    /** Each buffered copy's own prior for this receiver, by its sequence; a copy without a record has none. */
    readonly bufferedPriorSeqs: Readonly<Record<number, number>>;
}

export interface ALOrderingAcceptance {
    readonly observation: ALOrderingObservation;
    readonly nextSnapshot?: ALOrderingTrackSnapshot;
}

interface ALOrderingTrackInput {
    readonly input: ComputeALOrderingObservationInput;
    readonly trackKey: string;
    readonly seq: number;
    readonly snapshot: ALOrderingTrackSnapshot | undefined;
    readonly expectedSeq: number;
    /** The record's prior for this receiver; `undefined` when no authority recorded the copy. */
    readonly priorSeq: number | undefined;
}

const UNTRACKED: ALOrderingAcceptance = { observation: { status: 'untracked', missingRanges: [], releasableSeqs: [] } };

/**
 * A recipient opens a recorded track at its first copy (`entered`), delivers a copy whose record names its own position
 * as the prior (`omitted`), and asks for a gap that ends at a prior ahead of it. A prior behind its position, or `0`
 * on a track it holds, says nothing it does not know, so today's rule from its own position applies, as it does to a
 * copy no authority recorded.
 */
export function computeALOrderingObservation(input: ComputeALOrderingObservationInput): ALOrderingAcceptance {
    const trackKey = toALOrderingTrackKey(input.msg);
    const seq = input.msg.ordering?.seq;
    if (trackKey === undefined || seq === undefined || input.role === 'none') {
        return UNTRACKED;
    }
    const snapshot = input.snapshot && input.snapshot.updatedAtMs + input.trackTtlMs > input.nowMs
        ? input.snapshot
        : undefined;
    const record = input.msg.ordering?.priorSeqByRecipient;
    const track: ALOrderingTrackInput = {
        input,
        trackKey,
        seq,
        snapshot,
        expectedSeq: snapshot ? Math.min(Number.MAX_SAFE_INTEGER, snapshot.lastContiguousSeq + 1) : 1,
        priorSeq: record === undefined ? undefined : record[input.selfPeerId] ?? seq - 1
    };
    if (input.role === 'witness') {
        return computeWitnessedOrdering(track);
    }
    // Inspect lengths and numeric distance before allocating a set or enumerating a repair gap.
    if ((snapshot?.bufferedSeqs.length ?? 0) > AL_MESSAGE_RESOURCE_LIMITS.bufferedMessages) {
        return toOrderingNoop(track, 'resync-required');
    }
    if (track.priorSeq !== undefined && snapshot === undefined) {
        return computeContiguousOrdering(track, 'entered');
    }
    if (snapshot && seq <= snapshot.lastContiguousSeq) {
        return toOrderingNoop(track, seq === snapshot.lastContiguousSeq ? 'duplicate' : 'stale');
    }
    if (snapshot?.bufferedSeqs.includes(seq)) {
        return toOrderingNoop(track, 'duplicate');
    }
    return computeTrackedOrdering(track);
}

/** A tracked copy above the receiver's position: in order, an omission, or a gap ending at the record's prior. */
function computeTrackedOrdering(track: ALOrderingTrackInput): ALOrderingAcceptance {
    const lastContiguousSeq = track.snapshot?.lastContiguousSeq ?? 0;
    const priorSeq = track.priorSeq;
    const informative = priorSeq !== undefined && priorSeq > 0 && priorSeq >= lastContiguousSeq && priorSeq < track.seq;
    const missingThrough = informative ? priorSeq : track.seq - 1;
    if (missingThrough - lastContiguousSeq > AL_MESSAGE_RESOURCE_LIMITS.repairWindow) {
        return toOrderingNoop(track, 'resync-required');
    }
    if (missingThrough > lastContiguousSeq) {
        return computeGapOrdering(track, missingThrough);
    }
    return computeContiguousOrdering(track, track.seq > track.expectedSeq ? 'omitted' : 'in-order');
}

function computeContiguousOrdering(
    track: ALOrderingTrackInput,
    status: 'in-order' | 'entered' | 'omitted'
): ALOrderingAcceptance {
    const buffered = new Set(track.snapshot?.bufferedSeqs ?? []);
    const releasableSeqs: number[] = [];
    let lastContiguousSeq = track.seq;
    let released = resolveReleasableSeq(buffered, lastContiguousSeq, track.input.bufferedPriorSeqs);
    while (released !== undefined) {
        lastContiguousSeq = released;
        buffered.delete(released);
        releasableSeqs.push(released);
        released = resolveReleasableSeq(buffered, lastContiguousSeq, track.input.bufferedPriorSeqs);
    }
    const observedContiguousSeq = track.input.apply ? lastContiguousSeq : track.seq;
    return {
        observation: {
            status,
            trackKey: track.trackKey,
            seq: track.seq,
            expectedSeq: Math.min(Number.MAX_SAFE_INTEGER, observedContiguousSeq + 1),
            lastContiguousSeq: observedContiguousSeq,
            missingRanges: [],
            releasableSeqs,
            ...toPriorSeq(track)
        },
        nextSnapshot: track.input.apply
            ? { lastContiguousSeq, bufferedSeqs: [...buffered].sort((a, b) => a - b), updatedAtMs: track.input.nowMs }
            : track.snapshot
    };
}

/** The buffered copy that follows `lastContiguousSeq`: its next sequence, or a copy whose own prior it is. */
function resolveReleasableSeq(
    buffered: ReadonlySet<number>,
    lastContiguousSeq: number,
    bufferedPriorSeqs: Readonly<Record<number, number>>
): number | undefined {
    if (lastContiguousSeq < Number.MAX_SAFE_INTEGER && buffered.has(lastContiguousSeq + 1)) {
        return lastContiguousSeq + 1;
    }
    let releasable: number | undefined;
    for (const seq of buffered) {
        if (bufferedPriorSeqs[seq] === lastContiguousSeq && (releasable === undefined || seq < releasable)) {
            releasable = seq;
        }
    }
    return releasable;
}

function computeGapOrdering(track: ALOrderingTrackInput, missingThrough: number): ALOrderingAcceptance {
    if ((track.snapshot?.bufferedSeqs.length ?? 0) >= AL_MESSAGE_RESOURCE_LIMITS.bufferedMessages) {
        return toOrderingNoop(track, 'resync-required');
    }
    const buffered = new Set(track.snapshot?.bufferedSeqs ?? []);
    return {
        observation: {
            status: 'gap',
            trackKey: track.trackKey,
            seq: track.seq,
            expectedSeq: track.expectedSeq,
            lastContiguousSeq: track.snapshot?.lastContiguousSeq ?? 0,
            missingRanges: computeMissingRanges(track.expectedSeq, missingThrough + 1, buffered),
            releasableSeqs: [],
            ...toPriorSeq(track)
        },
        nextSnapshot: track.input.apply
            ? {
                lastContiguousSeq: track.snapshot?.lastContiguousSeq ?? 0,
                bufferedSeqs: [...buffered, track.seq].sort((a, b) => a - b),
                updatedAtMs: track.input.nowMs
            }
            : track.snapshot
    };
}

/** A witness delivers nothing: its position moves to the copy, and a buffered copy at or below it is let go. */
function computeWitnessedOrdering(track: ALOrderingTrackInput): ALOrderingAcceptance {
    const lastContiguousSeq = Math.max(track.snapshot?.lastContiguousSeq ?? 0, track.seq);
    const bufferedSeqs = (track.snapshot?.bufferedSeqs ?? []).filter((seq) => seq > lastContiguousSeq);
    return {
        observation: {
            status: 'witnessed',
            trackKey: track.trackKey,
            seq: track.seq,
            expectedSeq: Math.min(Number.MAX_SAFE_INTEGER, lastContiguousSeq + 1),
            lastContiguousSeq,
            missingRanges: [],
            releasableSeqs: [],
            ...toPriorSeq(track)
        },
        nextSnapshot: track.input.apply
            ? { lastContiguousSeq, bufferedSeqs, updatedAtMs: track.input.nowMs }
            : track.snapshot
    };
}

/** Each run of sequences in `[expectedSeq, endSeq)` that the buffer lacks becomes one inclusive range. */
function computeMissingRanges(
    expectedSeq: number,
    endSeq: number,
    buffered: ReadonlySet<number>
): readonly ALSeqRange[] {
    const missingRanges: ALSeqRange[] = [];
    let candidate = expectedSeq;
    while (candidate < endSeq) {
        if (buffered.has(candidate)) {
            candidate += 1;
            continue;
        }
        const from = candidate;
        while (candidate < endSeq && !buffered.has(candidate)) {
            candidate += 1;
        }
        missingRanges.push({ from, to: candidate - 1 });
    }
    return missingRanges;
}

function toPriorSeq(track: ALOrderingTrackInput): Pick<ALOrderingObservation, 'priorSeq'> {
    return track.priorSeq === undefined ? {} : { priorSeq: track.priorSeq };
}

function toOrderingNoop(
    track: ALOrderingTrackInput,
    status: 'duplicate' | 'stale' | 'resync-required'
): ALOrderingAcceptance {
    return {
        observation: {
            status,
            trackKey: track.trackKey,
            seq: track.seq,
            expectedSeq: track.expectedSeq,
            lastContiguousSeq: track.snapshot?.lastContiguousSeq ?? 0,
            missingRanges: [],
            releasableSeqs: [],
            ...toPriorSeq(track)
        }
    };
}
