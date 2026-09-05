import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOrderingTrackSnapshot } from '@shared/al-contracts/al-runtime.ts';
import { computeALOrderingObservation } from '@shared/alm/compute-al-ordering-observation.ts';
import { describe, expect, it } from 'vitest';

describe('AL ordering repair window', () => {
    it('requests resynchronization for a maximum-safe-integer initial sequence without expanding its gap', () => {
        const result = computeALOrderingObservation({
            msg: orderedMessage(Number.MAX_SAFE_INTEGER),
            snapshot: undefined,
            nowMs: 1_000,
            trackTtlMs: 60_000,
            apply: true
        });

        expect(result.observation).toMatchObject({
            status: 'resync-required',
            expectedSeq: 1,
            missingSeqs: [],
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
            apply: true
        });
        const outside = computeALOrderingObservation({
            msg: orderedMessage(258),
            snapshot: undefined,
            nowMs: 1_000,
            trackTtlMs: 60_000,
            apply: true
        });

        expect(atLimit.observation.status).toBe('gap');
        expect(atLimit.observation.missingSeqs).toEqual(Array.from({ length: 256 }, (_, index) => index + 1));
        expect(atLimit.nextSnapshot?.bufferedSeqs).toEqual([257]);
        expect(outside.observation.status).toBe('resync-required');
        expect(outside.observation.missingSeqs).toEqual([]);
        expect(outside.nextSnapshot).toBeUndefined();
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
            apply: true
        });

        expect(result.observation).toMatchObject({ status: 'resync-required', expectedSeq: 9, missingSeqs: [] });
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
            apply: true
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
            apply: true
        });
        const second = computeALOrderingObservation({
            msg: orderedMessage(5),
            snapshot: first.nextSnapshot,
            nowMs: 1_002,
            trackTtlMs: 60_000,
            apply: true
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
                apply: true
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
            apply: true
        });

        expect(result.observation).toMatchObject({ status: 'resync-required', expectedSeq: 1, missingSeqs: [] });
        expect(result.nextSnapshot).toBeUndefined();
    });
});

function orderedMessage(seq: number): ALMessage {
    return {
        id: { v: 2, msgId: `message-${seq}`, senderId: 'sender', ts: 1_000 },
        route: { topicId: 'chat', resourceId: 'conversation', contextId: 'room' },
        targets: { mode: 'unicast', toPeerId: 'receiver' },
        ordering: { orderingKey: 'conversation', epoch: 0, seq },
        payload: { typeId: 'text', resource: '"hello"' }
    };
}
