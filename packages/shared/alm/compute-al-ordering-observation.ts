import type { ALMessage } from '../al-contracts/al-contract.ts';
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

interface ALOrderingState {
    lastContiguousSeq: number;
    readonly bufferedSeqs: Set<number>;
    updatedAtMs: number;
}

interface ComputeTrackedALOrderingObservationInput {
    readonly ordering: ComputeALOrderingObservationInput;
    readonly state: ALOrderingState;
    readonly trackKey: string;
    readonly seq: number;
}

interface ToALOrderingObservationInput {
    readonly status: 'stale' | 'duplicate';
    readonly trackKey: string;
    readonly seq: number;
    readonly expectedSeq: number;
    readonly lastContiguousSeq: number;
}

export function computeALOrderingObservation(
    input: ComputeALOrderingObservationInput
): ALOrderingAcceptance {
    const trackKey = toALOrderingTrackKey(input.msg);
    const seq = input.msg.ordering?.seq;
    if (trackKey === undefined || seq === undefined) {
        return {
            observation: {
                status: 'untracked',
                missingSeqs: [],
                releasableSeqs: []
            }
        };
    }

    const state = toALOrderingState(input.snapshot, input.nowMs, input.trackTtlMs);
    return state
        ? computeTrackedALOrderingObservation({ ordering: input, state, trackKey, seq })
        : computeInitialALOrderingObservation(input, trackKey, seq);
}

function computeInitialALOrderingObservation(
    input: ComputeALOrderingObservationInput,
    trackKey: string,
    seq: number
): ALOrderingAcceptance {
    const isGap = seq > 1;
    return {
        observation: isGap
            ? {
                status: 'gap',
                trackKey,
                seq,
                expectedSeq: 1,
                lastContiguousSeq: 0,
                missingSeqs: Array.from({ length: seq - 1 }, (_, index) => index + 1),
                releasableSeqs: []
            }
            : {
                status: 'in-order',
                trackKey,
                seq,
                expectedSeq: seq,
                lastContiguousSeq: seq,
                missingSeqs: [],
                releasableSeqs: []
            },
        nextSnapshot: input.apply
            ? {
                lastContiguousSeq: isGap ? 0 : seq,
                bufferedSeqs: isGap ? [seq] : [],
                updatedAtMs: input.nowMs
            }
            : undefined
    };
}

function computeTrackedALOrderingObservation(
    input: ComputeTrackedALOrderingObservationInput
): ALOrderingAcceptance {
    const expectedSeq = input.state.lastContiguousSeq + 1;
    if (input.seq < input.state.lastContiguousSeq) {
        return toALOrderingObservation({
            status: 'stale',
            trackKey: input.trackKey,
            seq: input.seq,
            expectedSeq,
            lastContiguousSeq: input.state.lastContiguousSeq
        });
    }
    if (input.seq === input.state.lastContiguousSeq || input.state.bufferedSeqs.has(input.seq)) {
        return toALOrderingObservation({
            status: 'duplicate',
            trackKey: input.trackKey,
            seq: input.seq,
            expectedSeq,
            lastContiguousSeq: input.state.lastContiguousSeq
        });
    }
    return input.seq === expectedSeq
        ? computeContiguousALOrderingObservation(input)
        : computeGapALOrderingObservation(input);
}

function computeContiguousALOrderingObservation(
    input: ComputeTrackedALOrderingObservationInput
): ALOrderingAcceptance {
    const releasableSeqs: number[] = [];
    let lastContiguousSeq = input.seq;
    if (input.ordering.apply) {
        input.state.lastContiguousSeq = input.seq;
        while (input.state.bufferedSeqs.has(input.state.lastContiguousSeq + 1)) {
            input.state.lastContiguousSeq += 1;
            input.state.bufferedSeqs.delete(input.state.lastContiguousSeq);
            releasableSeqs.push(input.state.lastContiguousSeq);
        }
        input.state.updatedAtMs = input.ordering.nowMs;
        lastContiguousSeq = input.state.lastContiguousSeq;
    }
    else {
        let candidateSeq = input.seq;
        while (input.state.bufferedSeqs.has(candidateSeq + 1)) {
            candidateSeq += 1;
            releasableSeqs.push(candidateSeq);
        }
    }

    return {
        observation: {
            status: 'in-order',
            trackKey: input.trackKey,
            seq: input.seq,
            expectedSeq: lastContiguousSeq + 1,
            lastContiguousSeq,
            missingSeqs: [],
            releasableSeqs
        },
        nextSnapshot: input.ordering.apply ? toALOrderingTrackSnapshot(input.state) : input.ordering.snapshot
    };
}

function computeGapALOrderingObservation(
    input: ComputeTrackedALOrderingObservationInput
): ALOrderingAcceptance {
    const expectedSeq = input.state.lastContiguousSeq + 1;
    const missingSeqs: number[] = [];
    for (let candidate = expectedSeq; candidate < input.seq; candidate += 1) {
        if (!input.state.bufferedSeqs.has(candidate)) {
            missingSeqs.push(candidate);
        }
    }
    if (input.ordering.apply) {
        input.state.bufferedSeqs.add(input.seq);
        input.state.updatedAtMs = input.ordering.nowMs;
    }

    return {
        observation: {
            status: 'gap',
            trackKey: input.trackKey,
            seq: input.seq,
            expectedSeq,
            lastContiguousSeq: input.state.lastContiguousSeq,
            missingSeqs,
            releasableSeqs: []
        },
        nextSnapshot: input.ordering.apply ? toALOrderingTrackSnapshot(input.state) : input.ordering.snapshot
    };
}

function toALOrderingObservation(
    input: ToALOrderingObservationInput
): ALOrderingAcceptance {
    return {
        observation: {
            status: input.status,
            trackKey: input.trackKey,
            seq: input.seq,
            expectedSeq: input.expectedSeq,
            lastContiguousSeq: input.lastContiguousSeq,
            missingSeqs: [],
            releasableSeqs: []
        }
    };
}

function toALOrderingState(
    snapshot: ALOrderingTrackSnapshot | undefined,
    nowMs: number,
    trackTtlMs: number
): ALOrderingState | undefined {
    if (!snapshot || snapshot.updatedAtMs + trackTtlMs <= nowMs) {
        return undefined;
    }

    return {
        lastContiguousSeq: snapshot.lastContiguousSeq,
        bufferedSeqs: new Set(snapshot.bufferedSeqs),
        updatedAtMs: snapshot.updatedAtMs
    };
}

function toALOrderingTrackSnapshot(
    state: ALOrderingState
): ALOrderingTrackSnapshot {
    return {
        lastContiguousSeq: state.lastContiguousSeq,
        bufferedSeqs: [...state.bufferedSeqs].sort((left, right) => left - right),
        updatedAtMs: state.updatedAtMs
    };
}
