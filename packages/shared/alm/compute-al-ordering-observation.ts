import type { ALMessage } from '../al-contracts/al-contract.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../al-contracts/al-message-resource-limits.ts';
import type { ALOrderingObservation, ALOrderingTrackSnapshot } from '../al-contracts/al-runtime.ts';
import { toALOrderingTrackKey } from '../al-contracts/al-runtime.ts';

export interface ComputeALOrderingObservationInput {
    readonly snapshot: ALOrderingTrackSnapshot | undefined;
    readonly msg: ALMessage;
    readonly nowMs: number;
    readonly trackTtlMs: number;
    readonly apply: boolean;
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
}

export function computeALOrderingObservation(input: ComputeALOrderingObservationInput): ALOrderingAcceptance {
    const trackKey = toALOrderingTrackKey(input.msg);
    const seq = input.msg.ordering?.seq;
    if (trackKey === undefined || seq === undefined) {
        return { observation: { status: 'untracked', missingSeqs: [], releasableSeqs: [] } };
    }
    const snapshot = input.snapshot && input.snapshot.updatedAtMs + input.trackTtlMs > input.nowMs
        ? input.snapshot
        : undefined;
    const track: ALOrderingTrackInput = {
        input,
        trackKey,
        seq,
        snapshot,
        expectedSeq: snapshot ? Math.min(Number.MAX_SAFE_INTEGER, snapshot.lastContiguousSeq + 1) : 1
    };
    // Inspect lengths and numeric distance before allocating a set or enumerating a repair gap.
    if ((snapshot?.bufferedSeqs.length ?? 0) > AL_MESSAGE_RESOURCE_LIMITS.bufferedMessages) {
        return toOrderingNoop(track, 'resync-required');
    }
    if (snapshot && seq <= snapshot.lastContiguousSeq) {
        return toOrderingNoop(track, seq === snapshot.lastContiguousSeq ? 'duplicate' : 'stale');
    }
    if (snapshot?.bufferedSeqs.includes(seq)) {
        return toOrderingNoop(track, 'duplicate');
    }
    if (seq - track.expectedSeq > AL_MESSAGE_RESOURCE_LIMITS.repairWindow) {
        return toOrderingNoop(track, 'resync-required');
    }
    return seq <= track.expectedSeq ? computeContiguousOrdering(track) : computeGapOrdering(track);
}

function computeContiguousOrdering(track: ALOrderingTrackInput): ALOrderingAcceptance {
    const buffered = new Set(track.snapshot?.bufferedSeqs ?? []);
    const releasableSeqs: number[] = [];
    let lastContiguousSeq = track.seq;
    while (lastContiguousSeq < Number.MAX_SAFE_INTEGER && buffered.has(lastContiguousSeq + 1)) {
        lastContiguousSeq += 1;
        buffered.delete(lastContiguousSeq);
        releasableSeqs.push(lastContiguousSeq);
    }
    const observedContiguousSeq = track.input.apply ? lastContiguousSeq : track.seq;
    return {
        observation: {
            status: 'in-order',
            trackKey: track.trackKey,
            seq: track.seq,
            expectedSeq: Math.min(Number.MAX_SAFE_INTEGER, observedContiguousSeq + 1),
            lastContiguousSeq: observedContiguousSeq,
            missingSeqs: [],
            releasableSeqs
        },
        nextSnapshot: track.input.apply
            ? { lastContiguousSeq, bufferedSeqs: [...buffered].sort((a, b) => a - b), updatedAtMs: track.input.nowMs }
            : track.snapshot
    };
}

function computeGapOrdering(track: ALOrderingTrackInput): ALOrderingAcceptance {
    if ((track.snapshot?.bufferedSeqs.length ?? 0) >= AL_MESSAGE_RESOURCE_LIMITS.bufferedMessages) {
        return toOrderingNoop(track, 'resync-required');
    }
    const buffered = new Set(track.snapshot?.bufferedSeqs ?? []);
    const missingSeqs: number[] = [];
    for (let candidate = track.expectedSeq; candidate < track.seq; candidate += 1) {
        if (!buffered.has(candidate)) {
            missingSeqs.push(candidate);
        }
    }
    return {
        observation: {
            status: 'gap',
            trackKey: track.trackKey,
            seq: track.seq,
            expectedSeq: track.expectedSeq,
            lastContiguousSeq: track.snapshot?.lastContiguousSeq ?? 0,
            missingSeqs,
            releasableSeqs: []
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
            missingSeqs: [],
            releasableSeqs: []
        }
    };
}
