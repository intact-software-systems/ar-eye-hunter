import { describe, expect, it } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOrderingTrackSnapshot } from '@shared/al-contracts/al-runtime.ts';
import {
    computeALOrderingHeldEntry,
    type ALOrderingHeldEntry,
    type ComputeALOrderingHeldEntryInput
} from '@shared/alm/inbound/gap-renewal/compute-al-ordering-held-entry.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

describe('the bounded hold: a track opened at its start whose last gap renewal went unanswered', () => {
    it('enters at its lowest buffered copy and releases that copy and its contiguous successors', () => {
        const result = enterHeld({ msg: recordedMessage(2, {}), snapshot: { lastContiguousSeq: 0, bufferedSeqs: [2, 3], updatedAtMs: 1_000 } });

        expect(result?.observation).toEqual({
            status: 'entered',
            trackKey: expect.any(String),
            seq: 2,
            expectedSeq: 4,
            lastContiguousSeq: 3,
            missingRanges: [],
            releasableSeqs: [2, 3],
            priorSeq: 1
        });
        expect(result?.nextSnapshot).toEqual({ lastContiguousSeq: 3, bufferedSeqs: [], updatedAtMs: 1_001 });
    });

    it('keeps a successor past a further gap buffered behind the new position', () => {
        const result = enterHeld({ msg: recordedMessage(2, {}), snapshot: { lastContiguousSeq: 0, bufferedSeqs: [2, 5], updatedAtMs: 1_000 } });

        expect(result?.observation).toMatchObject({ status: 'entered', seq: 2, lastContiguousSeq: 2, releasableSeqs: [2] });
        expect(result?.nextSnapshot).toEqual({ lastContiguousSeq: 2, bufferedSeqs: [5], updatedAtMs: 1_001 });
    });

    it('releases a successor whose own record names the lowest copy as its prior', () => {
        const result = enterHeld({
            msg: recordedMessage(2, {}),
            snapshot: { lastContiguousSeq: 0, bufferedSeqs: [2, 5], updatedAtMs: 1_000 },
            bufferedPriorSeqs: { 2: 1, 5: 2 }
        });

        expect(result?.observation).toMatchObject({ lastContiguousSeq: 5, releasableSeqs: [2, 5] });
    });

    it.each<[string, Partial<ComputeALOrderingHeldEntryInput>]>([
        ['a track that delivered something', { snapshot: { lastContiguousSeq: 1, bufferedSeqs: [3], updatedAtMs: 1_000 }, msg: recordedMessage(3, {}) }],
        ['a copy that is not the lowest one buffered', { msg: recordedMessage(3, {}) }],
        ['a track past its TTL', { snapshot: { lastContiguousSeq: 0, bufferedSeqs: [2, 3], updatedAtMs: -60_000 } }],
        ['a copy no authority recorded', { msg: orderedMessage(2) }],
        ['a copy frozen to another audience', { msg: recordedMessage(2, {}, ['other']) }],
        ['a copy whose plan repairs no gap', { repairsGaps: false }],
        ['a latest-wins copy', { latestWins: true }]
    ])('holds no start for %s, which keeps today\'s behaviour', (_name, overrides) => {
        expect(enterHeld({
            msg: recordedMessage(2, {}),
            snapshot: { lastContiguousSeq: 0, bufferedSeqs: [2, 3], updatedAtMs: 1_000 },
            ...overrides
        })).toBeUndefined();
    });
});

interface EnterHeldInput {
    readonly msg: ALMessage;
    readonly snapshot: ALOrderingTrackSnapshot | undefined;
    /** Absent, no buffered copy carries a record. */
    readonly bufferedPriorSeqs?: Readonly<Record<number, number>>;
    /** Absent, the copy's plan supersedes nothing. */
    readonly latestWins?: boolean;
    /** Absent, the copy's plan repairs gaps. */
    readonly repairsGaps?: boolean;
}

function enterHeld(input: EnterHeldInput): ALOrderingHeldEntry | undefined {
    return computeALOrderingHeldEntry({
        msg: input.msg,
        snapshot: input.snapshot,
        nowMs: 1_001,
        trackTtlMs: 60_000,
        selfPeerId: 'receiver',
        bufferedPriorSeqs: input.bufferedPriorSeqs ?? {},
        latestWins: input.latestWins ?? false,
        repairsGaps: input.repairsGaps ?? true
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
