import { describe, expect, it } from 'vitest';

import type { ALSeqRange } from '@shared/al-contracts/al-runtime.ts';
import type { ALOutboundRepairHint } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';

import {
    computeOrderedSendRepairReoffers,
    type OrderedSendSentMessage
} from '../../../../../../apps/api-v1/scripts/perf/alm-ordered-send/client-stand-in/compute-ordered-send-repair-reoffers.ts';

const SERVER = 'default-qbox-server';
const TRACK = '["ordered-send-cell","default","room-1"]:session-01-a:0';
const NO_ATTEMPTS_SERVED: ReadonlySet<string> = new Set();

/** The sends 1 to `count` of the publisher's track, none of them repaired yet, each with four repairs to spend. */
function toSentMessages(count: number): OrderedSendSentMessage[] {
    return Array.from({ length: count }, (_, index) => ({
        msgId: `session-01-a-send-${index + 1}`,
        trackKey: TRACK,
        seq: index + 1,
        maxRepairs: 4,
        repairAttempts: 0
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

describe('computeOrderedSendRepairReoffers', () => {
    it('re-offers exactly the missing sequences a request names, ascending, never the send whose arrival showed the gap', () => {
        const repair = computeOrderedSendRepairReoffers({
            hint: toGapHint([{ from: 3, to: 4 }, { from: 6, to: 6 }], 1),
            namedMsgId: 'session-01-a-send-8',
            sentMessages: toSentMessages(8),
            servedAttemptIdentities: NO_ATTEMPTS_SERVED
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
        const first = computeOrderedSendRepairReoffers({
            hint: toGapHint([{ from: 3, to: 3 }], 1),
            namedMsgId: 'session-01-a-send-4',
            sentMessages: toSentMessages(8),
            servedAttemptIdentities: NO_ATTEMPTS_SERVED
        });
        const served = new Set(first.reoffers.map(({ attemptIdentity }) => attemptIdentity));

        const reportedAgainByALaterArrival = computeOrderedSendRepairReoffers({
            hint: toGapHint([{ from: 3, to: 3 }, { from: 5, to: 5 }], 1),
            namedMsgId: 'session-01-a-send-6',
            sentMessages: toSentMessages(8),
            servedAttemptIdentities: served
        });
        const renewed = computeOrderedSendRepairReoffers({
            hint: toGapHint([{ from: 3, to: 3 }], 2),
            namedMsgId: 'session-01-a-send-4',
            sentMessages: toSentMessages(8).map((sent) => sent.seq === 3 ? { ...sent, repairAttempts: 1 } : sent),
            servedAttemptIdentities: served
        });

        expect(first.reoffers.map(({ msgId }) => msgId)).toEqual(['session-01-a-send-3']);
        expect(reportedAgainByALaterArrival.reoffers.map(({ msgId }) => msgId)).toEqual(['session-01-a-send-5']);
        expect(renewed.reoffers.map(({ msgId, attempt }) => [msgId, attempt])).toEqual([['session-01-a-send-3', 2]]);
    });

    it('re-offers no sequence its publisher has not offered, and none of another track', () => {
        const pastTheLastOffer = computeOrderedSendRepairReoffers({
            hint: toGapHint([{ from: 7, to: 10 }], 1),
            namedMsgId: 'session-01-a-send-8',
            sentMessages: toSentMessages(8),
            servedAttemptIdentities: NO_ATTEMPTS_SERVED
        });
        const onAnotherTrack = computeOrderedSendRepairReoffers({
            hint: { ...toGapHint([{ from: 3, to: 3 }], 1), orderingTrackKey: `${TRACK}-of-another-epoch` },
            namedMsgId: 'session-01-a-send-8',
            sentMessages: toSentMessages(8),
            servedAttemptIdentities: NO_ATTEMPTS_SERVED
        });

        expect(pastTheLastOffer.reoffers.map(({ msgId }) => msgId))
            .toEqual(['session-01-a-send-7', 'session-01-a-send-8']);
        expect(onAnotherTrack.reoffers).toEqual([]);
    });

    it('spends at most the repairs the client plans for a message, and none for a message it plans none for', () => {
        const sentMessages: OrderedSendSentMessage[] = [
            { msgId: 'session-01-a-send-1', trackKey: TRACK, seq: 1, maxRepairs: 4, repairAttempts: 3 },
            { msgId: 'session-01-a-send-2', trackKey: TRACK, seq: 2, maxRepairs: 4, repairAttempts: 4 },
            { msgId: 'session-01-a-send-3', trackKey: TRACK, seq: 3, maxRepairs: 0, repairAttempts: 0 }
        ];

        const repair = computeOrderedSendRepairReoffers({
            hint: toGapHint([{ from: 1, to: 3 }], 5),
            namedMsgId: 'session-01-a-send-4',
            sentMessages,
            servedAttemptIdentities: NO_ATTEMPTS_SERVED
        });

        expect(repair.reoffers.map(({ msgId, attempt }) => [msgId, attempt])).toEqual([['session-01-a-send-1', 4]]);
    });

    it('serves 32 sequences of one request at a time and leaves the rest of its ranges as one follow-up hint', () => {
        const hint = toGapHint([{ from: 1, to: 20 }, { from: 22, to: 41 }], 1);

        const firstPage = computeOrderedSendRepairReoffers({
            hint,
            namedMsgId: 'session-01-a-send-45',
            sentMessages: toSentMessages(45),
            servedAttemptIdentities: NO_ATTEMPTS_SERVED
        });
        const secondPage = computeOrderedSendRepairReoffers({
            hint: firstPage.followUpHint!,
            namedMsgId: 'session-01-a-send-45',
            sentMessages: toSentMessages(45),
            servedAttemptIdentities: new Set(firstPage.reoffers.map(({ attemptIdentity }) => attemptIdentity))
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

        const first = computeOrderedSendRepairReoffers({
            hint,
            namedMsgId: 'session-01-a-send-5',
            sentMessages: toSentMessages(8),
            servedAttemptIdentities: NO_ATTEMPTS_SERVED
        });
        const again = computeOrderedSendRepairReoffers({
            hint,
            namedMsgId: 'session-01-a-send-5',
            sentMessages: toSentMessages(8),
            servedAttemptIdentities: new Set(first.reoffers.map(({ attemptIdentity }) => attemptIdentity))
        });

        expect(first.reoffers.map(({ msgId, attempt }) => [msgId, attempt])).toEqual([['session-01-a-send-5', 1]]);
        expect(first.followUpHint).toBeUndefined();
        expect(again.reoffers).toEqual([]);
    });
});
