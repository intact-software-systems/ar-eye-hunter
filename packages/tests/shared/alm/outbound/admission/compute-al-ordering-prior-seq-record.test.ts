import { describe, expect, it } from 'vitest';

import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    computeALOrderingPriorSeqRecord,
    isALOrderingPredecessorInBatch,
    toALOrderingBatchSequences
} from '@shared/alm/outbound/admission/compute-al-ordering-prior-seq-record.ts';

const TRACK_KEY = 'room-1:session-a:1';

describe('the prior-sequence record an authority signs on an ordered copy', () => {
    it('lists a recipient last sent a sequence below the previous one: its omission', () => {
        expect(computeALOrderingPriorSeqRecord({ trackKey: TRACK_KEY, seq: 5, priorSeqByRecipient: { b: 2 } })).toEqual({ b: 2 });
    });

    it('omits a recipient last sent the previous sequence: it reads the record as seq - 1', () => {
        expect(computeALOrderingPriorSeqRecord({ trackKey: TRACK_KEY, seq: 5, priorSeqByRecipient: { b: 4 } })).toEqual({});
    });

    it('omits a recipient never sent the track on its first sequence: seq - 1 is already 0', () => {
        expect(computeALOrderingPriorSeqRecord({ trackKey: TRACK_KEY, seq: 1, priorSeqByRecipient: { b: 0, c: 0 } })).toEqual({});
    });

    it('lists a recipient never sent the track as 0 on a later sequence', () => {
        expect(computeALOrderingPriorSeqRecord({ trackKey: TRACK_KEY, seq: 5, priorSeqByRecipient: { b: 0 } })).toEqual({ b: 0 });
    });

    it('omits a recipient already at or past the sequence: a receipt retry is not an exclusion', () => {
        expect(computeALOrderingPriorSeqRecord({ trackKey: TRACK_KEY, seq: 5, priorSeqByRecipient: { b: 5, c: 9 } })).toEqual({});
    });

    it('records nobody for an empty audience', () => {
        expect(computeALOrderingPriorSeqRecord({ trackKey: TRACK_KEY, seq: 5, priorSeqByRecipient: {} })).toEqual({});
    });
});

describe('the predecessor a dequeued batch claimed beside a tracked row', () => {
    const batch = toALOrderingBatchSequences([trackedMessage('game-1', 1), trackedMessage('game-1', 2), trackedMessage('game-2', 7)]);

    it('collects the sequences the batch claimed by track', () => {
        expect(batch).toEqual(new Map([['game-1:a:1', new Set([1, 2])], ['game-2:a:1', new Set([7])]]));
    });

    it('finds the row one sequence before on the same track', () => {
        expect(isALOrderingPredecessorInBatch(trackedMessage('game-1', 3), batch)).toBe(true);
    });

    it('finds no predecessor the batch claimed on another track, or further back than one sequence', () => {
        expect(isALOrderingPredecessorInBatch(trackedMessage('game-2', 9), batch)).toBe(false);
        expect(isALOrderingPredecessorInBatch(trackedMessage('game-3', 2), batch)).toBe(false);
    });

    it('finds none for an untracked row, which claims no sequence either, as an absent message claims none', () => {
        const untracked = { ...trackedMessage('game-1', 2), ordering: undefined };

        expect(isALOrderingPredecessorInBatch(untracked, batch)).toBe(false);
        expect(toALOrderingBatchSequences([untracked, undefined])).toEqual(new Map());
    });
});

function trackedMessage(orderingKey: string, seq: number): ALMessage {
    const room = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
    const message = newALBroadcastMessage('a', newALRoute('room.round.event', room.groupId, `event-${seq}`), 'room', 'round.event.v1', {}, { groupRef: room });
    return { ...message, ordering: { orderingKey, epoch: 1, seq } };
}
