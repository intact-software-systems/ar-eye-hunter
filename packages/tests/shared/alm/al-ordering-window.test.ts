import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOrderingObserverRole, ALOrderingTrackSnapshot } from '@shared/al-contracts/al-runtime.ts';
import {
    computeALOrderingObservation,
    type ALOrderingAcceptance
} from '@shared/alm/compute-al-ordering-observation.ts';
import {
    describe,
    expect,
    it
} from 'vitest';

const AS_RECIPIENT = { role: 'recipient', selfPeerId: 'receiver', bufferedPriorSeqs: {} } as const;

describe('AL ordering repair window', () => {
    it('requests resynchronization for a maximum-safe-integer initial sequence without expanding its gap', () => {
        const result = computeALOrderingObservation({
            msg: orderedMessage(Number.MAX_SAFE_INTEGER),
            snapshot: undefined,
            nowMs: 1_000,
            trackTtlMs: 60_000,
            apply: true,
            ...AS_RECIPIENT
        });

        expect(result.observation).toMatchObject({
            status: 'resync-required',
            expectedSeq: 1,
            missingRanges: [],
            releasableSeqs: []
        });
        expect(result.nextSnapshot).toBeUndefined();
    });

    it('repairs a gap of exactly 256 sequences and rejects a gap of 257', () => {
        const atLimit = computeALOrderingObservation({
            msg: orderedMessage(257),
            snapshot: undefined,
            nowMs: 1_000,
            trackTtlMs: 60_000,
            apply: true,
            ...AS_RECIPIENT
        });
        const outside = computeALOrderingObservation({
            msg: orderedMessage(258),
            snapshot: undefined,
            nowMs: 1_000,
            trackTtlMs: 60_000,
            apply: true,
            ...AS_RECIPIENT
        });

        expect(atLimit.observation.status).toBe('gap');
        expect(atLimit.observation.missingRanges).toEqual([{ from: 1, to: 256 }]);
        expect(atLimit.nextSnapshot?.bufferedSeqs).toEqual([257]);
        expect(outside.observation.status).toBe('resync-required');
        expect(outside.observation.missingRanges).toEqual([]);
        expect(outside.nextSnapshot).toBeUndefined();
    });

    it('states a gap of 2..5 with 3 buffered as the ranges 2-2 and 4-5', () => {
        const result = computeALOrderingObservation({
            msg: orderedMessage(6),
            snapshot: { lastContiguousSeq: 1, bufferedSeqs: [3], updatedAtMs: 1_000 },
            nowMs: 1_001,
            trackTtlMs: 60_000,
            apply: true,
            ...AS_RECIPIENT
        });

        expect(result.observation).toMatchObject({
            status: 'gap',
            expectedSeq: 2,
            lastContiguousSeq: 1,
            missingRanges: [{ from: 2, to: 2 }, { from: 4, to: 5 }],
            releasableSeqs: []
        });
        expect(result.nextSnapshot).toEqual({ lastContiguousSeq: 1, bufferedSeqs: [3, 6], updatedAtMs: 1_001 });
    });

    it('bounds a later gap without changing the observed track', () => {
        const snapshot = Object.freeze({
            lastContiguousSeq: 8,
            bufferedSeqs: Object.freeze([10, 12]),
            updatedAtMs: 1_000
        });
        const result = computeALOrderingObservation({
            msg: orderedMessage(1_000),
            snapshot,
            nowMs: 1_001,
            trackTtlMs: 60_000,
            apply: true,
            ...AS_RECIPIENT
        });

        expect(result.observation).toMatchObject({ status: 'resync-required', expectedSeq: 9, missingRanges: [] });
        expect(result.nextSnapshot).toBeUndefined();
        expect(snapshot).toEqual({ lastContiguousSeq: 8, bufferedSeqs: [10, 12], updatedAtMs: 1_000 });
    });

    it('does not enumerate an oversized retained sequence collection', () => {
        const bufferedSeqs = new Array<number>(257);
        Object.defineProperty(bufferedSeqs, 0, {
            get: () => {
                throw new Error('must not enumerate');
            }
        });
        const result = computeALOrderingObservation({
            msg: orderedMessage(1),
            snapshot: { lastContiguousSeq: 0, bufferedSeqs, updatedAtMs: 1_000 },
            nowMs: 1_001,
            trackTtlMs: 60_000,
            apply: true,
            ...AS_RECIPIENT
        });

        expect(result.observation.status).toBe('resync-required');
        expect(result.nextSnapshot).toBeUndefined();
    });

    it('releases sparse retained messages only as their predecessors arrive', () => {
        const snapshot: ALOrderingTrackSnapshot = Object.freeze({
            lastContiguousSeq: 1,
            bufferedSeqs: Object.freeze([3, 4, 6]),
            updatedAtMs: 1_000
        });
        const first = computeALOrderingObservation({
            msg: orderedMessage(2),
            snapshot,
            nowMs: 1_001,
            trackTtlMs: 60_000,
            apply: true,
            ...AS_RECIPIENT
        });
        const second = computeALOrderingObservation({
            msg: orderedMessage(5),
            snapshot: first.nextSnapshot,
            nowMs: 1_002,
            trackTtlMs: 60_000,
            apply: true,
            ...AS_RECIPIENT
        });

        expect(first.observation.releasableSeqs).toEqual([3, 4]);
        expect(first.nextSnapshot).toEqual({ lastContiguousSeq: 4, bufferedSeqs: [6], updatedAtMs: 1_001 });
        expect(second.observation.releasableSeqs).toEqual([6]);
        expect(second.nextSnapshot).toEqual({ lastContiguousSeq: 6, bufferedSeqs: [], updatedAtMs: 1_002 });
        expect(snapshot.bufferedSeqs).toEqual([3, 4, 6]);
    });

    it('does not refresh retention or mutate state for duplicate and stale arrivals', () => {
        const snapshot = Object.freeze({
            lastContiguousSeq: 4,
            bufferedSeqs: Object.freeze([6]),
            updatedAtMs: 1_000
        });
        for (const seq of [3, 4, 6]) {
            const result = computeALOrderingObservation({
                msg: orderedMessage(seq),
                snapshot,
                nowMs: 1_001,
                trackTtlMs: 60_000,
                apply: true,
                ...AS_RECIPIENT
            });
            expect(result.observation.status).toBe(seq === 3 ? 'stale' : 'duplicate');
            expect(result.nextSnapshot).toBeUndefined();
        }
        expect(snapshot).toEqual({ lastContiguousSeq: 4, bufferedSeqs: [6], updatedAtMs: 1_000 });
    });

    it('applies the initial window again after retained state expires', () => {
        const result = computeALOrderingObservation({
            msg: orderedMessage(1_001),
            snapshot: { lastContiguousSeq: 1_000, bufferedSeqs: [], updatedAtMs: 1_000 },
            nowMs: 61_000,
            trackTtlMs: 60_000,
            apply: true,
            ...AS_RECIPIENT
        });

        expect(result.observation).toMatchObject({ status: 'resync-required', expectedSeq: 1, missingRanges: [] });
        expect(result.nextSnapshot).toBeUndefined();
    });
});

describe('a recorded track at its recipient: entry, omission and the record\'s prior', () => {
    it('enters a recorded track at its first copy, 300 past anything, with no window check and nothing below it a gap', () => {
        const result = observe({ msg: recordedMessage(300, {}), snapshot: undefined });

        expect(result.observation).toEqual({
            status: 'entered',
            trackKey: expect.any(String),
            seq: 300,
            expectedSeq: 301,
            lastContiguousSeq: 300,
            missingRanges: [],
            releasableSeqs: [],
            priorSeq: 299
        });
        expect(result.nextSnapshot).toEqual({ lastContiguousSeq: 300, bufferedSeqs: [], updatedAtMs: 1_001 });
    });

    it('delivers an omission at its own position and releases a buffered successor that follows it in sequence', () => {
        const result = observe({
            msg: recordedMessage(5, { receiver: 2 }),
            snapshot: { lastContiguousSeq: 2, bufferedSeqs: [6], updatedAtMs: 1_000 },
            bufferedPriorSeqs: { 6: 5 }
        });

        expect(result.observation).toMatchObject({
            status: 'omitted',
            seq: 5,
            lastContiguousSeq: 6,
            missingRanges: [],
            releasableSeqs: [6],
            priorSeq: 2
        });
        expect(result.nextSnapshot).toEqual({ lastContiguousSeq: 6, bufferedSeqs: [], updatedAtMs: 1_001 });
    });

    it('releases past an omission a buffered copy whose own record names the new position as its prior', () => {
        const result = observe({
            msg: recordedMessage(5, { receiver: 2 }),
            snapshot: { lastContiguousSeq: 2, bufferedSeqs: [9], updatedAtMs: 1_000 },
            bufferedPriorSeqs: { 9: 5 }
        });

        expect(result.observation).toMatchObject({ status: 'omitted', releasableSeqs: [9], lastContiguousSeq: 9 });
        expect(result.nextSnapshot).toEqual({ lastContiguousSeq: 9, bufferedSeqs: [], updatedAtMs: 1_001 });
    });

    it('releases a buffered copy past its own omission once a repaired copy reaches its prior', () => {
        const result = observe({
            msg: recordedMessage(3, {}),
            snapshot: { lastContiguousSeq: 2, bufferedSeqs: [6], updatedAtMs: 1_000 },
            bufferedPriorSeqs: { 6: 3 }
        });

        expect(result.observation).toMatchObject({ status: 'in-order', releasableSeqs: [6], lastContiguousSeq: 6 });
    });

    it('asks for a gap that ends at the record\'s prior when that prior is ahead of the receiver, buffering the copy', () => {
        const result = observe({
            msg: recordedMessage(9, { receiver: 5 }),
            snapshot: { lastContiguousSeq: 2, bufferedSeqs: [], updatedAtMs: 1_000 }
        });

        expect(result.observation).toMatchObject({
            status: 'gap',
            seq: 9,
            expectedSeq: 3,
            lastContiguousSeq: 2,
            missingRanges: [{ from: 3, to: 5 }],
            priorSeq: 5
        });
        expect(result.nextSnapshot).toEqual({ lastContiguousSeq: 2, bufferedSeqs: [9], updatedAtMs: 1_001 });
    });

    it.each<[string, number, Readonly<Record<string, number>>, number, readonly { from: number; to: number; }[]]>([
        ['a prior behind the receiver, the next sequence', 5, { receiver: 1 }, 4, []],
        ['a prior behind the receiver, past a gap', 7, { receiver: 1 }, 4, [{ from: 5, to: 6 }]],
        ['a prior of 0 with a snapshot', 7, { receiver: 0 }, 4, [{ from: 5, to: 6 }]]
    ])('reads no information from %s: the receiver\'s own position rules', (_name, seq, record, lastContiguousSeq, missingRanges) => {
        const result = observe({
            msg: recordedMessage(seq, record),
            snapshot: { lastContiguousSeq, bufferedSeqs: [], updatedAtMs: 1_000 }
        });

        expect(result.observation).toMatchObject({
            status: missingRanges.length === 0 ? 'in-order' : 'gap',
            missingRanges,
            priorSeq: record.receiver
        });
    });

    it('asks from 1 for a prior of 0 on a track with only a buffered copy: the position 0 is no omission', () => {
        const result = observe({
            msg: recordedMessage(6, { receiver: 0 }),
            snapshot: { lastContiguousSeq: 0, bufferedSeqs: [4], updatedAtMs: 1_000 }
        });

        expect(result.observation).toMatchObject({ status: 'gap', missingRanges: [{ from: 1, to: 3 }, { from: 5, to: 5 }] });
    });

    it.each<[string, Readonly<Record<string, number>>, 'in-order' | 'gap']>([
        ['another recipient', { other: 1 }, 'gap'],
        ['nobody', {}, 'in-order']
    ])('reads a record that lists %s but not the receiver as a prior of seq - 1', (_name, record, status) => {
        const result = observe({
            msg: recordedMessage(5, record),
            snapshot: { lastContiguousSeq: status === 'gap' ? 2 : 4, bufferedSeqs: [], updatedAtMs: 1_000 }
        });

        expect(result.observation).toMatchObject({ status, priorSeq: 4 });
        expect(result.observation.missingRanges).toEqual(status === 'gap' ? [{ from: 3, to: 4 }] : []);
    });
});

describe('a track observed by a witness or by nobody', () => {
    it('moves a witness\'s position to the copy, buffering nothing and dropping buffered copies at or below it', () => {
        const result = observe({
            msg: recordedMessage(7, {}),
            snapshot: { lastContiguousSeq: 2, bufferedSeqs: [6, 9], updatedAtMs: 1_000 },
            role: 'witness'
        });

        expect(result.observation).toMatchObject({
            status: 'witnessed',
            seq: 7,
            lastContiguousSeq: 7,
            missingRanges: [],
            releasableSeqs: []
        });
        expect(result.nextSnapshot).toEqual({ lastContiguousSeq: 7, bufferedSeqs: [9], updatedAtMs: 1_001 });
    });

    it('never moves a witness backwards and checks no window, with or without a record', () => {
        const behind = observe({
            msg: orderedMessage(3),
            snapshot: { lastContiguousSeq: 5, bufferedSeqs: [], updatedAtMs: 1_000 },
            role: 'witness'
        });
        const far = observe({ msg: orderedMessage(900), snapshot: undefined, role: 'witness' });

        expect(behind.observation).toMatchObject({ status: 'witnessed', lastContiguousSeq: 5 });
        expect(far.nextSnapshot).toEqual({ lastContiguousSeq: 900, bufferedSeqs: [], updatedAtMs: 1_001 });
    });

    it('observes nothing for a peer that is neither recipient nor witness: no position, nothing to refuse', () => {
        const result = observe({
            msg: recordedMessage(300, {}),
            snapshot: { lastContiguousSeq: 2, bufferedSeqs: [], updatedAtMs: 1_000 },
            role: 'none'
        });

        expect(result).toEqual({ observation: { status: 'untracked', missingRanges: [], releasableSeqs: [] } });
    });
});

interface ObserveInput {
    readonly msg: ALMessage;
    readonly snapshot: ALOrderingTrackSnapshot | undefined;
    /** Absent, a recipient. */
    readonly role?: ALOrderingObserverRole;
    /** Absent, no buffered copy carries a record. */
    readonly bufferedPriorSeqs?: Readonly<Record<number, number>>;
}

function observe(input: ObserveInput): ALOrderingAcceptance {
    return computeALOrderingObservation({
        msg: input.msg,
        snapshot: input.snapshot,
        nowMs: 1_001,
        trackTtlMs: 60_000,
        apply: true,
        role: input.role ?? 'recipient',
        selfPeerId: 'receiver',
        bufferedPriorSeqs: input.bufferedPriorSeqs ?? {}
    });
}

/** A copy whose authority recorded `priorSeqByRecipient`: only recipients whose prior is below `seq - 1`. */
function recordedMessage(seq: number, priorSeqByRecipient: Readonly<Record<string, number>>): ALMessage {
    const message = orderedMessage(seq);
    return { ...message, ordering: { ...message.ordering, priorSeqByRecipient } };
}

function orderedMessage(seq: number): ALMessage {
    return {
        id: { v: 4, msgId: `message-${seq}`, senderId: 'sender', ts: 1_000, traceId: 'trace-al-ordering-window' },
        route: { topicId: 'chat', resourceId: 'conversation', contextId: 'room' },
        targets: { mode: 'unicast', toPeerId: 'receiver' },
        ordering: { orderingKey: 'conversation', epoch: 0, seq },
        payload: { typeId: 'text', resource: '"hello"' }
    };
}
