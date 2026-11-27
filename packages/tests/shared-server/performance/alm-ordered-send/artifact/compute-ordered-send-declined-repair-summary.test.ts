import { describe, expect, it } from 'vitest';

import { computeOrderedSendDeclinedRepairSummary } from '../../../../../../apps/api-v1/scripts/perf/alm-ordered-send/artifact/compute-ordered-send-declined-repair-summary.ts';
import type { OrderedSendCellDeclinedRepair } from '../../../../../../apps/api-v1/scripts/perf/alm-ordered-send/ordered-send-cell-observations.ts';

const FIRST = 'session-01-a-send-1';
const SECOND = 'session-01-a-send-2';
const THIRD = 'session-01-a-send-3';
const OTHER_TRACK = 'session-02-b-send-1';

/**
 * 324 declines of four sends, in the order declined. Rounds 1 to 150, 10 ms apart from 1,010 ms, each decline the
 * first send as ended and, 1 ms later, the second as expired: 300 declines. Rounds 151 to 170 decline the first send
 * as expired: 20. Then three requests name the third send, expired, a millisecond apart from 40,000 ms, and one
 * decline of another track's send ends the list.
 */
const DECLINED: readonly OrderedSendCellDeclinedRepair[] = [
    ...Array.from({ length: 150 }, (_, index): OrderedSendCellDeclinedRepair[] => [
        { msgId: FIRST, reason: 'send-ended', atMs: 1_010 + index * 10 },
        { msgId: SECOND, reason: 'send-expired', atMs: 1_011 + index * 10 }
    ]).flat(),
    ...Array.from({ length: 20 }, (_, index): OrderedSendCellDeclinedRepair => ({
        msgId: FIRST,
        reason: 'send-expired',
        atMs: 2_510 + index * 10
    })),
    { msgId: THIRD, reason: 'named-send-expired', atMs: 40_000 },
    { msgId: THIRD, reason: 'named-send-expired', atMs: 40_001 },
    { msgId: THIRD, reason: 'named-send-expired', atMs: 40_002 },
    { msgId: OTHER_TRACK, reason: 'send-ended', atMs: 50_000 }
];

describe('computeOrderedSendDeclinedRepairSummary', () => {
    it('counts the declines by reason, keeps the first 200 as they are, and states each send and reason once with its count and its first and last instant', () => {
        const summary = computeOrderedSendDeclinedRepairSummary(DECLINED);

        expect(DECLINED).toHaveLength(324);
        expect(summary.countByReason).toEqual({ 'send-ended': 151, 'send-expired': 170, 'named-send-expired': 3 });
        expect(summary.firstDeclined).toEqual(DECLINED.slice(0, 200));
        expect(summary.firstDeclined).toHaveLength(200);
        expect(summary.firstDeclined[0]).toEqual({ msgId: FIRST, reason: 'send-ended', atMs: 1_010 });
        expect(summary.firstDeclined[199]).toEqual({ msgId: SECOND, reason: 'send-expired', atMs: 2_001 });
        expect(summary.bySendAndReason).toEqual([
            { msgId: FIRST, reason: 'send-ended', count: 150, firstAtMs: 1_010, lastAtMs: 2_500 },
            { msgId: SECOND, reason: 'send-expired', count: 150, firstAtMs: 1_011, lastAtMs: 2_501 },
            { msgId: FIRST, reason: 'send-expired', count: 20, firstAtMs: 2_510, lastAtMs: 2_700 },
            { msgId: THIRD, reason: 'named-send-expired', count: 3, firstAtMs: 40_000, lastAtMs: 40_002 },
            { msgId: OTHER_TRACK, reason: 'send-ended', count: 1, firstAtMs: 50_000, lastAtMs: 50_000 }
        ]);
        expect(Object.keys(summary).toSorted()).toEqual(['bySendAndReason', 'countByReason', 'firstDeclined']);
    });

    it('summarises a run that declined nothing as nothing, every reason at 0', () => {
        expect(computeOrderedSendDeclinedRepairSummary([])).toEqual({
            countByReason: { 'send-ended': 0, 'send-expired': 0, 'named-send-expired': 0 },
            firstDeclined: [],
            bySendAndReason: []
        });
    });
});
