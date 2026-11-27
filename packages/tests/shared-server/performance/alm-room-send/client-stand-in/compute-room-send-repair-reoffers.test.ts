import { describe, expect, it } from 'vitest';

import type { ALSeqRange } from '@shared/al-contracts/al-runtime.ts';
import type { ALOutboundRepairHint } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';

import {
    computeRoomSendRepairReoffers,
    type RoomSendSentMessage
} from '../../../../../../apps/api-v1/scripts/perf/alm-room-send/client-stand-in/compute-room-send-repair-reoffers.ts';

const SERVER = 'default-qbox-server';
const TRACK = '["room-send-cell","default","room-1"]:session-01-a:0';
const NO_ATTEMPTS_SERVED: ReadonlySet<string> = new Set();

/** Every request here is served at this instant, one second before the sends' lifetime ends. */
const NOW_MS = 30_000;

/**
 * The sends 1 to `count` of the publisher's track, none of them repaired yet, each with four repairs to spend, alive
 * until 31,000 ms and not ended.
 */
function toSentMessages(count: number): RoomSendSentMessage[] {
    return Array.from({ length: count }, (_, index) => ({
        msgId: `session-01-a-send-${index + 1}`,
        trackKey: TRACK,
        seq: index + 1,
        maxRepairs: 4,
        repairAttempts: 0,
        expiresAtMs: 31_000,
        ended: false
    }));
}

/** The hint of a gap the server reports on the publisher's track, as the product's client builds it. */
function toGapHint(missingRanges: readonly ALSeqRange[], gapRequestNumber: number): ALOutboundRepairHint {
    return {
        trigger: 'nack',
        requestedByPeerId: SERVER,
        orderingTrackKey: TRACK,
        missingRanges,
        gapRequestNumber,
        failedPeerIds: []
    };
}

describe('computeRoomSendRepairReoffers', () => {
    it('re-offers exactly the missing sequences a request names, ascending, never the send whose arrival showed the gap', () => {
        const repair = computeRoomSendRepairReoffers({
            hint: toGapHint([{ from: 3, to: 4 }, { from: 6, to: 6 }], 1),
            namedMsgId: 'session-01-a-send-8',
            sentMessages: toSentMessages(8),
            servedAttemptIdentities: NO_ATTEMPTS_SERVED,
            nowMs: NOW_MS
        });

        expect(repair.reoffers.map(({ msgId, attempt }) => [msgId, attempt])).toEqual([
            ['session-01-a-send-3', 1],
            ['session-01-a-send-4', 1],
            ['session-01-a-send-6', 1]
        ]);
        expect(new Set(repair.reoffers.map(({ attemptIdentity }) => attemptIdentity)).size).toBe(3);
        expect(repair.followUpHint).toBeUndefined();
    });

    it('serves a sequence once for each request number, whichever arrival reports its gap', () => {
        const first = computeRoomSendRepairReoffers({
            hint: toGapHint([{ from: 3, to: 3 }], 1),
            namedMsgId: 'session-01-a-send-4',
            sentMessages: toSentMessages(8),
            servedAttemptIdentities: NO_ATTEMPTS_SERVED,
            nowMs: NOW_MS
        });
        const served = new Set(first.reoffers.map(({ attemptIdentity }) => attemptIdentity));

        const reportedAgainByALaterArrival = computeRoomSendRepairReoffers({
            hint: toGapHint([{ from: 3, to: 3 }, { from: 5, to: 5 }], 1),
            namedMsgId: 'session-01-a-send-6',
            sentMessages: toSentMessages(8),
            servedAttemptIdentities: served,
            nowMs: NOW_MS
        });
        const renewed = computeRoomSendRepairReoffers({
            hint: toGapHint([{ from: 3, to: 3 }], 2),
            namedMsgId: 'session-01-a-send-4',
            sentMessages: toSentMessages(8).map((sent) => sent.seq === 3 ? { ...sent, repairAttempts: 1 } : sent),
            servedAttemptIdentities: served,
            nowMs: NOW_MS
        });

        expect(first.reoffers.map(({ msgId }) => msgId)).toEqual(['session-01-a-send-3']);
        expect(reportedAgainByALaterArrival.reoffers.map(({ msgId }) => msgId)).toEqual(['session-01-a-send-5']);
        expect(renewed.reoffers.map(({ msgId, attempt }) => [msgId, attempt])).toEqual([['session-01-a-send-3', 2]]);
    });

    it('re-offers no sequence its publisher has not offered, and none of another track', () => {
        const pastTheLastOffer = computeRoomSendRepairReoffers({
            hint: toGapHint([{ from: 7, to: 10 }], 1),
            namedMsgId: 'session-01-a-send-8',
            sentMessages: toSentMessages(8),
            servedAttemptIdentities: NO_ATTEMPTS_SERVED,
            nowMs: NOW_MS
        });
        const onAnotherTrack = computeRoomSendRepairReoffers({
            hint: { ...toGapHint([{ from: 3, to: 3 }], 1), orderingTrackKey: `${TRACK}-of-another-epoch` },
            namedMsgId: 'session-01-a-send-8',
            sentMessages: toSentMessages(8),
            servedAttemptIdentities: NO_ATTEMPTS_SERVED,
            nowMs: NOW_MS
        });

        expect(pastTheLastOffer.reoffers.map(({ msgId }) => msgId))
            .toEqual(['session-01-a-send-7', 'session-01-a-send-8']);
        expect(onAnotherTrack.reoffers).toEqual([]);
    });

    it('re-offers a send with a repair left, names one whose repairs are spent for its publisher to end, and passes over one the client plans no repair for', () => {
        const [one, two, three] = toSentMessages(3);
        const sentMessages: RoomSendSentMessage[] = [
            { ...one, repairAttempts: 3 },
            { ...two, repairAttempts: 4 },
            { ...three, maxRepairs: undefined }
        ];

        const repair = computeRoomSendRepairReoffers({
            hint: toGapHint([{ from: 1, to: 3 }], 5),
            namedMsgId: 'session-01-a-send-4',
            sentMessages,
            servedAttemptIdentities: NO_ATTEMPTS_SERVED,
            nowMs: NOW_MS
        });

        expect(repair.reoffers.map(({ msgId, attempt }) => [msgId, attempt])).toEqual([['session-01-a-send-1', 4]]);
        expect(repair.budgetSpentMsgIds).toEqual(['session-01-a-send-2']);
        expect(repair.declined).toEqual([]);
    });

    it('finds no budget spent for a request number it has served before: the same gap reported again ends nothing', () => {
        const hint = toGapHint([{ from: 2, to: 2 }], 4);
        const fourthRepair = computeRoomSendRepairReoffers({
            hint,
            namedMsgId: 'session-01-a-send-3',
            sentMessages: toSentMessages(3).map((sent) => sent.seq === 2 ? { ...sent, repairAttempts: 3 } : sent),
            servedAttemptIdentities: NO_ATTEMPTS_SERVED,
            nowMs: NOW_MS
        });

        const reportedAgain = computeRoomSendRepairReoffers({
            hint,
            namedMsgId: 'session-01-a-send-3',
            sentMessages: toSentMessages(3).map((sent) => sent.seq === 2 ? { ...sent, repairAttempts: 4 } : sent),
            servedAttemptIdentities: new Set(fourthRepair.reoffers.map(({ attemptIdentity }) => attemptIdentity)),
            nowMs: NOW_MS
        });

        expect(fourthRepair.reoffers.map(({ msgId, attempt }) => [msgId, attempt])).toEqual([['session-01-a-send-2', 4]]);
        expect(reportedAgain).toEqual({ reoffers: [], declined: [], budgetSpentMsgIds: [], followUpHint: undefined });
    });

    it('re-offers no send its publisher has ended, whatever repairs it has left, and says which it declined', () => {
        const repair = computeRoomSendRepairReoffers({
            hint: toGapHint([{ from: 2, to: 4 }], 1),
            namedMsgId: 'session-01-a-send-5',
            sentMessages: toSentMessages(5).map((sent) => sent.seq === 3 ? { ...sent, ended: true } : sent),
            servedAttemptIdentities: NO_ATTEMPTS_SERVED,
            nowMs: NOW_MS
        });

        expect(repair.reoffers.map(({ msgId }) => msgId)).toEqual(['session-01-a-send-2', 'session-01-a-send-4']);
        expect(repair.declined).toEqual([{ msgId: 'session-01-a-send-3', reason: 'send-ended' }]);
        expect(repair.budgetSpentMsgIds).toEqual([]);
    });

    it('re-offers no send whose lifetime is over at the instant the request is served, ended or not', () => {
        const sentMessages = toSentMessages(4).map((sent) => {
            if (sent.seq === 1) {
                return { ...sent, expiresAtMs: 30_000 };
            }
            return sent.seq === 2 ? { ...sent, expiresAtMs: 29_000, ended: true } : { ...sent, expiresAtMs: 30_000.5 };
        });

        const repair = computeRoomSendRepairReoffers({
            hint: toGapHint([{ from: 1, to: 3 }], 1),
            namedMsgId: 'session-01-a-send-4',
            sentMessages,
            servedAttemptIdentities: NO_ATTEMPTS_SERVED,
            nowMs: NOW_MS
        });

        expect(repair.reoffers.map(({ msgId }) => msgId)).toEqual(['session-01-a-send-3']);
        expect(repair.declined).toEqual([
            { msgId: 'session-01-a-send-1', reason: 'send-expired' },
            { msgId: 'session-01-a-send-2', reason: 'send-expired' }
        ]);
    });

    it('declines the send a request without a range names once that send has ended', () => {
        const repair = computeRoomSendRepairReoffers({
            hint: { trigger: 'repair', requestedByPeerId: SERVER, missingRanges: [], failedPeerIds: [] },
            namedMsgId: 'session-01-a-send-2',
            sentMessages: toSentMessages(2).map((sent) => sent.seq === 2 ? { ...sent, ended: true } : sent),
            servedAttemptIdentities: NO_ATTEMPTS_SERVED,
            nowMs: NOW_MS
        });

        expect(repair).toEqual({
            reoffers: [],
            declined: [{ msgId: 'session-01-a-send-2', reason: 'send-ended' }],
            budgetSpentMsgIds: [],
            followUpHint: undefined
        });
    });

    it('serves 32 sequences of one request at a time and leaves the rest of its ranges as one follow-up hint', () => {
        const hint = toGapHint([{ from: 1, to: 20 }, { from: 22, to: 41 }], 1);

        const firstPage = computeRoomSendRepairReoffers({
            hint,
            namedMsgId: 'session-01-a-send-45',
            sentMessages: toSentMessages(45),
            servedAttemptIdentities: NO_ATTEMPTS_SERVED,
            nowMs: NOW_MS
        });
        const secondPage = computeRoomSendRepairReoffers({
            hint: firstPage.followUpHint!,
            namedMsgId: 'session-01-a-send-45',
            sentMessages: toSentMessages(45),
            servedAttemptIdentities: new Set(firstPage.reoffers.map(({ attemptIdentity }) => attemptIdentity)),
            nowMs: NOW_MS
        });

        const firstThirtyTwoMissingSeqs = [...Array.from({ length: 20 }, (_, index) => index + 1), 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33];
        expect(firstPage.reoffers.map(({ msgId }) => msgId))
            .toEqual(firstThirtyTwoMissingSeqs.map((seq) => `session-01-a-send-${seq}`));
        expect(firstPage.followUpHint).toEqual({ ...hint, missingRanges: [{ from: 34, to: 41 }] });
        expect(secondPage.reoffers.map(({ msgId }) => msgId)).toEqual(
            [34, 35, 36, 37, 38, 39, 40, 41].map((seq) => `session-01-a-send-${seq}`)
        );
        expect(secondPage.followUpHint).toBeUndefined();
    });

    it('re-offers the send a request names when the request names no range, once', () => {
        const hint: ALOutboundRepairHint = {
            trigger: 'repair',
            requestedByPeerId: SERVER,
            missingRanges: [],
            failedPeerIds: []
        };

        const first = computeRoomSendRepairReoffers({
            hint,
            namedMsgId: 'session-01-a-send-5',
            sentMessages: toSentMessages(8),
            servedAttemptIdentities: NO_ATTEMPTS_SERVED,
            nowMs: NOW_MS
        });
        const again = computeRoomSendRepairReoffers({
            hint,
            namedMsgId: 'session-01-a-send-5',
            sentMessages: toSentMessages(8),
            servedAttemptIdentities: new Set(first.reoffers.map(({ attemptIdentity }) => attemptIdentity)),
            nowMs: NOW_MS
        });

        expect(first.reoffers.map(({ msgId, attempt }) => [msgId, attempt])).toEqual([['session-01-a-send-5', 1]]);
        expect(first.followUpHint).toBeUndefined();
        expect(again.reoffers).toEqual([]);
    });
});
