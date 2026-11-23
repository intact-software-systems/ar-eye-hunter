import { describe, expect, it } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOrderingTrackSnapshot, ALSeqRange } from '@shared/al-contracts/al-runtime.ts';
import {
    computeALOrderingHeldEntry,
    isALOrderingHeldStartRange,
    type ALOrderingHeldEntry
} from '@shared/alm/inbound/gap-renewal/compute-al-ordering-held-entry.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

describe('the bounded hold: a track opened at its start whose last gap renewal went unanswered', () => {
    it('enters at its lowest live copy and releases that copy and its contiguous live successors', () => {
        const result = endHold({ live: [recordedMessage(2, {}), recordedMessage(3, {})] });

        expect(result).toEqual({
            kind: 'entered',
            trackKey: expect.any(String),
            msg: recordedMessage(2, {}),
            observation: {
                status: 'entered',
                trackKey: expect.any(String),
                seq: 2,
                expectedSeq: 4,
                lastContiguousSeq: 3,
                missingRanges: [],
                releasableSeqs: [2, 3],
                priorSeq: 1
            },
            nextSnapshot: { lastContiguousSeq: 3, bufferedSeqs: [], updatedAtMs: 1_001 },
            passedPriorSeqs: {},
            completesThrough: {}
        });
    });

    it('keeps a live successor past a further gap buffered behind the new position', () => {
        const result = endHold({
            snapshot: { lastContiguousSeq: 0, bufferedSeqs: [2, 5], updatedAtMs: 1_000 },
            live: [recordedMessage(2, {}), recordedMessage(5, {})]
        });

        expect(result).toMatchObject({ kind: 'entered', observation: { seq: 2, lastContiguousSeq: 2, releasableSeqs: [2] } });
        expect(result?.nextSnapshot).toEqual({ lastContiguousSeq: 2, bufferedSeqs: [5], updatedAtMs: 1_001 });
    });

    it('releases a live successor whose own record names the lowest copy as its prior', () => {
        const result = endHold({
            snapshot: { lastContiguousSeq: 0, bufferedSeqs: [2, 5], updatedAtMs: 1_000 },
            live: [recordedMessage(2, {}), recordedMessage(5, { receiver: 2 })]
        });

        expect(result).toMatchObject({ kind: 'entered', observation: { lastContiguousSeq: 5, releasableSeqs: [2, 5] } });
    });

    it('passes an expired lower copy and enters at the lowest copy still live, whatever revealed the range', () => {
        const result = endHold({ live: [recordedMessage(3, {})] });

        expect(result).toMatchObject({ kind: 'entered', msg: recordedMessage(3, {}), observation: { seq: 3, releasableSeqs: [3] } });
        expect(result?.nextSnapshot).toEqual({ lastContiguousSeq: 3, bufferedSeqs: [], updatedAtMs: 1_001 });
    });

    it('passes an expired copy between live ones, so the released run continues past it', () => {
        const result = endHold({
            snapshot: { lastContiguousSeq: 0, bufferedSeqs: [3, 4, 5], updatedAtMs: 1_000 },
            live: [recordedMessage(3, {}), recordedMessage(5, {})]
        });

        expect(result).toMatchObject({
            kind: 'entered',
            observation: { seq: 3, lastContiguousSeq: 5, releasableSeqs: [3, 5] },
            passedPriorSeqs: { 5: 3 }
        });
        expect(result?.nextSnapshot).toEqual({ lastContiguousSeq: 5, bufferedSeqs: [], updatedAtMs: 1_001 });
    });

    it('passes an expired copy after the released run, and the run\'s last copy completes the track through it', () => {
        const result = endHold({
            snapshot: { lastContiguousSeq: 0, bufferedSeqs: [3, 4, 6], updatedAtMs: 1_000 },
            live: [recordedMessage(3, {}), recordedMessage(6, {})]
        });

        expect(result).toMatchObject({
            kind: 'entered',
            observation: { seq: 3, lastContiguousSeq: 4, expectedSeq: 5, releasableSeqs: [3] },
            completesThrough: { 3: 4 }
        });
        expect(result?.nextSnapshot).toEqual({ lastContiguousSeq: 4, bufferedSeqs: [6], updatedAtMs: 1_001 });
    });

    it('passes every buffered sequence and releases nothing when every held copy expired', () => {
        expect(endHold({ live: [] })).toEqual({
            kind: 'passed',
            trackKey: expect.any(String),
            nextSnapshot: { lastContiguousSeq: 3, bufferedSeqs: [], updatedAtMs: 1_001 }
        });
    });

    it.each<[string, Partial<EndHoldInput>]>([
        ['a track that delivered something', { snapshot: { lastContiguousSeq: 1, bufferedSeqs: [3], updatedAtMs: 1_000 } }],
        ['a timer that holds no start', { heldStart: false }],
        ['a track past its TTL', { snapshot: { lastContiguousSeq: 0, bufferedSeqs: [2, 3], updatedAtMs: -60_000 } }],
        ['a track with nothing buffered', { snapshot: { lastContiguousSeq: 0, bufferedSeqs: [], updatedAtMs: 1_000 } }]
    ])('holds no start for %s, which keeps today\'s behaviour', (_name, overrides) => {
        expect(endHold(overrides)).toBeUndefined();
    });
});

describe('the timer of a held start range, as the admission that arms it decides', () => {
    it('holds the range 1..p the first recorded copy revealed', () => {
        expect(isHeldStartRange({})).toBe(true);
    });

    it.each<[string, Partial<HeldStartRangeInput>]>([
        ['a range above the track\'s start', { range: { from: 3, to: 4 } }],
        ['a revealing copy no authority recorded', { revealing: orderedMessage(2) }],
        ['a revealing copy frozen to another audience', { revealing: recordedMessage(2, {}, ['other']) }],
        ['a plan that repairs no gap', { repairsGaps: false }],
        ['a latest-wins plan', { latestWins: true }]
    ])('holds no start for %s', (_name, overrides) => {
        expect(isHeldStartRange(overrides)).toBe(false);
    });
});

interface HeldStartRangeInput {
    readonly range: ALSeqRange;
    /** The copy that revealed the range. */
    readonly revealing: ALMessage;
    readonly latestWins: boolean;
    readonly repairsGaps: boolean;
}

/** Absent fields: the start range `1..1` recorded copy 2 revealed, under a gap-repairing plan. */
function isHeldStartRange(input: Partial<HeldStartRangeInput>): boolean {
    return isALOrderingHeldStartRange({
        range: input.range ?? { from: 1, to: 1 },
        start: {
            msg: input.revealing ?? recordedMessage(2, {}),
            selfPeerId: 'receiver',
            evictedTrack: false,
            latestWins: input.latestWins ?? false,
            repairsGaps: input.repairsGaps ?? true
        }
    });
}

interface EndHoldInput {
    readonly heldStart: boolean;
    readonly snapshot: ALOrderingTrackSnapshot | undefined;
    readonly live: readonly ALMessage[];
}

/** Absent fields: a timer holding the start, copies 2 and 3 held and live. */
function endHold(input: Partial<EndHoldInput>): ALOrderingHeldEntry | undefined {
    return computeALOrderingHeldEntry({
        trackKey: 'conversation:sender:0',
        heldStart: input.heldStart ?? true,
        selfPeerId: 'receiver',
        snapshot: 'snapshot' in input ? input.snapshot : { lastContiguousSeq: 0, bufferedSeqs: [2, 3], updatedAtMs: 1_000 },
        live: input.live ?? [recordedMessage(2, {}), recordedMessage(3, {})],
        nowMs: 1_001,
        trackTtlMs: 60_000
    });
}

/**
 * A copy whose authority recorded `priorSeqByRecipient`: only recipients whose prior is below `seq - 1`. Its audience is
 * frozen to `recipientPeerIds`, the receiver by default, as an admission freezes a room copy.
 */
function recordedMessage(
    seq: number,
    priorSeqByRecipient: Readonly<Record<string, number>>,
    recipientPeerIds: readonly string[] = ['receiver']
): ALMessage {
    const message = orderedMessage(seq);
    return {
        ...message,
        targets: { mode: 'multicast', groupRef: ROOM, recipientPeerIds, snapshotVersion: 1 },
        ordering: { ...message.ordering, priorSeqByRecipient }
    };
}

function orderedMessage(seq: number): ALMessage {
    return {
        id: { v: 4, msgId: `message-${seq}`, senderId: 'sender', ts: 1_000, traceId: 'trace-al-ordering-held-entry' },
        route: { topicId: 'chat', resourceId: 'conversation', contextId: 'room' },
        targets: { mode: 'unicast', toPeerId: 'receiver' },
        ordering: { orderingKey: 'conversation', epoch: 0, seq },
        payload: { typeId: 'text', resource: '"hello"' }
    };
}
