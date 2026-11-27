import type { ALReceiptRecordEndedHead, ALReceiptRecordOpenHead } from '@shared/alm/receipt-record/al-receipt-record-rows.ts';
import { computeALReceiptRecordEnding } from '@shared/alm/receipt-record/compute-al-receipt-record-ending.ts';
import type { ALReceiptRecordTally } from '@shared/alm/receipt-record/compute-al-receipt-record-tally.ts';
import { describe, expect, it } from 'vitest';

const NOW = 1_000_000;
const head: ALReceiptRecordOpenHead = {
    phase: 'open',
    opening: {
        originPeerId: 'o',
        msgId: 'm',
        traceId: 't',
        expectedRecipientPeerIds: ['r1', 'r2', 'r3'],
        neverSentRecipientPeerIds: [],
        snapshotVersion: 7,
        deadlineAtMs: NOW + 5_000
    }
};
const completeTally: ALReceiptRecordTally = {
    confirmedRecipientPeerIds: ['r1', 'r3'],
    outsideAudienceRecipientPeerIds: ['r2'],
    complete: true
};
const partialTally: ALReceiptRecordTally = {
    confirmedRecipientPeerIds: ['r1'],
    outsideAudienceRecipientPeerIds: ['r2'],
    complete: false
};

function toEnding(tally: ALReceiptRecordTally, nowMs: number): 'not-due' | ALReceiptRecordEndedHead {
    return computeALReceiptRecordEnding({ head, tally, nowMs }).fold<'not-due' | ALReceiptRecordEndedHead>(
        (notDue) => notDue,
        (ended) => ended
    );
}

describe('computeALReceiptRecordEnding', () => {
    // Completion wins over the clock: a complete receipt found past its deadline still ends complete.
    it('ends complete when the tally is complete, even past the deadline', () => {
        expect(toEnding(completeTally, NOW + 9_000)).toEqual({
            phase: 'complete',
            opening: head.opening,
            confirmedRecipientPeerIds: ['r1', 'r3'],
            outsideAudienceRecipientPeerIds: ['r2'],
            endedAtEpochMs: NOW + 9_000
        });
    });

    it('is not due while an incomplete receipt is before its deadline', () => {
        expect(toEnding(partialTally, NOW + 4_999)).toBe('not-due');
    });

    // The deadline instant is already past, as for a confirmation: at it the receipt times out with what it has.
    it('times out an incomplete receipt at its deadline with the partial sets', () => {
        expect(toEnding(partialTally, NOW + 5_000)).toEqual({
            phase: 'timed-out',
            opening: head.opening,
            confirmedRecipientPeerIds: ['r1'],
            outsideAudienceRecipientPeerIds: ['r2'],
            endedAtEpochMs: NOW + 5_000
        });
    });
});
