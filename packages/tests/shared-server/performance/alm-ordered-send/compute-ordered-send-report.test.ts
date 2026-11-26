import { describe, expect, it } from 'vitest';

import { computeOrderedSendReport } from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/compute-ordered-send-report.ts';
import type {
    OrderedSendCellAnswer,
    OrderedSendCellControl,
    OrderedSendCellObservations,
    OrderedSendCellOffer
} from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/ordered-send-cell-observations.ts';

const NO_OBSERVATIONS: OrderedSendCellObservations = {
    sends: [],
    arrivals: [],
    handOffs: [],
    receipts: [],
    controls: [],
    unclassifiedControls: [],
    observationEndedAtMs: 0
};

const SEND = {
    publisherPeerId: 'publisher-1',
    seq: 1,
    dueAtMs: 0,
    sentAtMs: 0,
    answeredAtMs: 1,
    acceptance: 'admitted',
    expectedRecipientPeerIds: ['recipient-1', 'recipient-2']
} satisfies Omit<OrderedSendCellOffer, 'msgId'> & OrderedSendCellAnswer;

const DELAY_BOUNDS_MS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 60_000];

const NO_NACKS_BY_REASON = {
    duplicate: 0,
    gap: 0,
    'resync-required': 0,
    expired: 0,
    unauthorized: 0,
    'no-route': 0,
    overloaded: 0,
    stale: 0,
    'not-yet-in-sync': 0,
    'membership-fenced': 0,
    'no-leader': 0,
    'held-by-other': 0,
    unsupported: 0,
    'no-publish-grant': 0,
    'not-subscribed': 0,
    'before-entry': 0
};

const NO_SAMPLES = {
    count: 0,
    p50: null,
    p95: null,
    p99: null,
    max: null,
    histogram: {
        upperBounds: DELAY_BOUNDS_MS,
        bucketCounts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        count: 0,
        sum: 0,
        min: null,
        max: null
    },
    unrecordedSamples: 0
};

/** One send to one recipient for each delay, due and offered at the same instant a tenth of a second apart. */
function toSendsReadAfter(delaysMs: readonly number[]): OrderedSendCellObservations {
    return {
        ...NO_OBSERVATIONS,
        sends: delaysMs.map((_, index) => ({
            ...SEND,
            msgId: `send-${index + 1}`,
            seq: index + 1,
            dueAtMs: (index + 1) * 100,
            sentAtMs: (index + 1) * 100,
            answeredAtMs: (index + 1) * 100 + 1,
            expectedRecipientPeerIds: ['recipient-1']
        })),
        arrivals: delaysMs.map((delayMs, index) => ({
            msgId: `send-${index + 1}`,
            recipientPeerId: 'recipient-1',
            atMs: (index + 1) * 100 + delayMs
        }))
    };
}

describe('computeOrderedSendReport', () => {
    describe('sends', () => {
        it('counts sends by how the entry answered them and measures how late each left against its due time', () => {
            const report = computeOrderedSendReport({
                ...NO_OBSERVATIONS,
                sends: [
                    { ...SEND, msgId: 'on-time', dueAtMs: 500, sentAtMs: 500, answeredAtMs: 501 },
                    { ...SEND, msgId: 'late-by-2', dueAtMs: 0, sentAtMs: 2, answeredAtMs: 3 },
                    {
                        ...SEND,
                        msgId: 'late-by-7',
                        dueAtMs: 1_000,
                        sentAtMs: 1_007,
                        answeredAtMs: 1_008,
                        acceptance: 'pending-admission'
                    },
                    {
                        ...SEND,
                        msgId: 'late-by-1',
                        dueAtMs: 1_500,
                        sentAtMs: 1_501,
                        answeredAtMs: 1_502,
                        acceptance: 'rejected',
                        rejectionCode: 'unauthorized'
                    }
                ]
            });

            expect(report.sends.attempted).toBe(4);
            expect(report.sends.byAcceptance).toEqual({
                admitted: 2,
                duplicate: 0,
                'resync-required': 0,
                disposed: 0,
                'pending-admission': 1,
                'not-admitted': 0,
                control: 0,
                rejected: 1,
                unanswered: 0
            });
            expect(report.sends.latenessMs).toMatchObject({ count: 4, p50: 1, p95: 7, p99: 7, max: 7 });
        });

        it('breaks rejections down by code and refusals by reason, and times the answer of answered sends only', () => {
            const report = computeOrderedSendReport({
                ...NO_OBSERVATIONS,
                sends: [
                    { ...SEND, msgId: 'admitted', sentAtMs: 0, answeredAtMs: 4 },
                    {
                        ...SEND,
                        msgId: 'unauthorized-1',
                        sentAtMs: 100,
                        answeredAtMs: 101,
                        acceptance: 'rejected',
                        rejectionCode: 'unauthorized'
                    },
                    {
                        ...SEND,
                        msgId: 'unauthorized-2',
                        sentAtMs: 200,
                        answeredAtMs: 203,
                        acceptance: 'rejected',
                        rejectionCode: 'unauthorized'
                    },
                    {
                        ...SEND,
                        msgId: 'malformed',
                        sentAtMs: 300,
                        answeredAtMs: 302,
                        acceptance: 'rejected',
                        rejectionCode: 'malformed'
                    },
                    {
                        ...SEND,
                        msgId: 'expired-1',
                        sentAtMs: 400,
                        answeredAtMs: 405,
                        acceptance: 'not-admitted',
                        notAdmittedReason: 'expired'
                    },
                    {
                        ...SEND,
                        msgId: 'expired-2',
                        sentAtMs: 500,
                        answeredAtMs: 506,
                        acceptance: 'not-admitted',
                        notAdmittedReason: 'expired'
                    },
                    {
                        ...SEND,
                        msgId: 'storage-unavailable',
                        sentAtMs: 600,
                        answeredAtMs: 607,
                        acceptance: 'not-admitted',
                        notAdmittedReason: 'storage-unavailable'
                    },
                    { ...SEND, msgId: 'still-pending', sentAtMs: 700, answeredAtMs: null, acceptance: 'unanswered' }
                ]
            });

            expect(report.sends).toMatchObject({
                attempted: 8,
                byAcceptance: { admitted: 1, rejected: 3, 'not-admitted': 3, unanswered: 1 },
                offerToAnswerMs: { count: 7, p50: 4, p95: 7, p99: 7, max: 7, unrecordedSamples: 0 }
            });
            expect(report.sends.rejectedByCode).toEqual({ malformed: 1, oversized: 0, unauthorized: 2, unsupported: 0 });
            expect(report.sends.notAdmittedByReason).toEqual({ expired: 2, 'storage-unavailable': 1 });
        });

        it('counts a refusal whose reason is the name of a property every object inherits', () => {
            const report = computeOrderedSendReport({
                ...NO_OBSERVATIONS,
                sends: [
                    { ...SEND, msgId: 'refused-1', acceptance: 'not-admitted', notAdmittedReason: 'constructor' },
                    { ...SEND, msgId: 'refused-2', acceptance: 'not-admitted', notAdmittedReason: '__proto__' },
                    { ...SEND, msgId: 'refused-3', acceptance: 'not-admitted', notAdmittedReason: 'constructor' }
                ]
            });

            expect(Object.entries(report.sends.notAdmittedByReason).toSorted()).toEqual([
                ['__proto__', 1],
                ['constructor', 2]
            ]);
        });

        it('keeps a send offered before its due time out of every lateness figure and counts it apart', () => {
            const report = computeOrderedSendReport({
                ...NO_OBSERVATIONS,
                sends: [
                    { ...SEND, msgId: 'early-by-half', dueAtMs: 100, sentAtMs: 99.5 },
                    { ...SEND, msgId: 'late-by-2', dueAtMs: 200, sentAtMs: 202 },
                    { ...SEND, msgId: 'late-by-6', dueAtMs: 300, sentAtMs: 306 }
                ]
            });

            expect(report.sends.latenessMs).toEqual({
                count: 2,
                p50: 2,
                p95: 6,
                p99: 6,
                max: 6,
                histogram: {
                    upperBounds: DELAY_BOUNDS_MS,
                    bucketCounts: [0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
                    count: 2,
                    sum: 8,
                    min: 2,
                    max: 6
                },
                unrecordedSamples: 1
            });
        });
    });

    describe('delivery', () => {
        it('counts a message as delivered only when every expected recipient read a copy', () => {
            const report = computeOrderedSendReport({
                ...NO_OBSERVATIONS,
                sends: [
                    { ...SEND, msgId: 'read-by-both', seq: 1 },
                    { ...SEND, msgId: 'read-by-one', seq: 2 },
                    { ...SEND, msgId: 'read-by-none', seq: 3 }
                ],
                arrivals: [
                    { msgId: 'read-by-both', recipientPeerId: 'recipient-1', atMs: 10 },
                    { msgId: 'read-by-both', recipientPeerId: 'recipient-2', atMs: 11 },
                    { msgId: 'read-by-one', recipientPeerId: 'recipient-1', atMs: 12 }
                ]
            });

            expect(report.delivery).toMatchObject({
                deliveredToEveryRecipient: 1,
                deliveredToAnyRecipient: 2,
                copiesRead: 3,
                copiesExpected: 6
            });
        });

        it('does not count a send that expected no recipient as delivered to every recipient', () => {
            const report = computeOrderedSendReport({
                ...NO_OBSERVATIONS,
                sends: [
                    { ...SEND, msgId: 'read-by-both', seq: 1 },
                    { ...SEND, msgId: 'expects-nobody', seq: 2, expectedRecipientPeerIds: [] }
                ],
                arrivals: [
                    { msgId: 'read-by-both', recipientPeerId: 'recipient-1', atMs: 10 },
                    { msgId: 'read-by-both', recipientPeerId: 'recipient-2', atMs: 11 }
                ]
            });

            expect(report.delivery).toMatchObject({
                deliveredToEveryRecipient: 1,
                deliveredToAnyRecipient: 1,
                copiesRead: 2,
                copiesExpected: 2
            });
        });

        it('counts a message handed more than once or by two instances and a copy read twice, and times the first hand-off from the offer', () => {
            const report = computeOrderedSendReport({
                ...NO_OBSERVATIONS,
                sends: [
                    { ...SEND, msgId: 'handed-once', seq: 1, dueAtMs: 0, sentAtMs: 0.5 },
                    { ...SEND, msgId: 'handed-twice', seq: 2, dueAtMs: 0, sentAtMs: 1 },
                    { ...SEND, msgId: 'handed-three-times', seq: 3, dueAtMs: 0, sentAtMs: 1 },
                    { ...SEND, msgId: 'never-handed', seq: 4 }
                ],
                handOffs: [
                    { msgId: 'handed-once', instanceIndex: 0, atMs: 1 },
                    { msgId: 'handed-twice', instanceIndex: 0, atMs: 2 },
                    { msgId: 'handed-twice', instanceIndex: 0, atMs: 3 },
                    { msgId: 'handed-three-times', instanceIndex: 1, atMs: 4 },
                    { msgId: 'handed-three-times', instanceIndex: 1, atMs: 5 },
                    { msgId: 'handed-three-times', instanceIndex: 2, atMs: 6 }
                ],
                arrivals: [
                    { msgId: 'handed-once', recipientPeerId: 'recipient-1', atMs: 10 },
                    { msgId: 'handed-once', recipientPeerId: 'recipient-2', atMs: 11 },
                    { msgId: 'handed-once', recipientPeerId: 'recipient-1', atMs: 12 },
                    { msgId: 'handed-three-times', recipientPeerId: 'recipient-1', atMs: 13 }
                ]
            });

            expect(report.delivery).toMatchObject({
                handedToApplication: 3,
                handedMoreThanOnce: 2,
                handedByMoreThanOneInstance: 1,
                largestHandOffMultiplicity: 3,
                offerToFirstHandOffMs: { count: 3, p50: 1, p95: 3, p99: 3, max: 3, unrecordedSamples: 0 },
                copiesRead: 3,
                copiesReadMoreThanOnce: 1
            });
        });
    });

    describe('track order', () => {
        it('counts a copy read before its predecessor on the same track as out of order', () => {
            const recipients = ['swaps-first-two', 'reads-in-order', 'reads-third-first'];
            const report = computeOrderedSendReport({
                ...NO_OBSERVATIONS,
                sends: [
                    { ...SEND, msgId: 'a1', seq: 1, expectedRecipientPeerIds: recipients },
                    { ...SEND, msgId: 'a2', seq: 2, expectedRecipientPeerIds: recipients },
                    { ...SEND, msgId: 'a3', seq: 3, expectedRecipientPeerIds: recipients },
                    { ...SEND, msgId: 'b1', seq: 1, publisherPeerId: 'publisher-2', expectedRecipientPeerIds: recipients }
                ],
                arrivals: [
                    { msgId: 'a2', recipientPeerId: 'swaps-first-two', atMs: 10 },
                    { msgId: 'a1', recipientPeerId: 'swaps-first-two', atMs: 11 },
                    { msgId: 'a3', recipientPeerId: 'swaps-first-two', atMs: 12 },
                    { msgId: 'b1', recipientPeerId: 'swaps-first-two', atMs: 13 },
                    { msgId: 'a1', recipientPeerId: 'reads-in-order', atMs: 10 },
                    { msgId: 'a2', recipientPeerId: 'reads-in-order', atMs: 11 },
                    { msgId: 'a3', recipientPeerId: 'reads-in-order', atMs: 12 },
                    { msgId: 'b1', recipientPeerId: 'reads-in-order', atMs: 13 },
                    { msgId: 'a1', recipientPeerId: 'reads-in-order', atMs: 20 },
                    { msgId: 'a3', recipientPeerId: 'reads-third-first', atMs: 10 },
                    { msgId: 'a1', recipientPeerId: 'reads-third-first', atMs: 11 },
                    { msgId: 'a2', recipientPeerId: 'reads-third-first', atMs: 12 },
                    { msgId: 'b1', recipientPeerId: 'reads-third-first', atMs: 13 }
                ]
            });

            expect(report.delivery.copiesReadOutOfTrackOrder).toBe(2);
        });

        it('takes track order from the order the copies were read in, not from instants that tie', () => {
            const recipients = ['reads-second-first', 'reads-in-order'];
            const report = computeOrderedSendReport({
                ...NO_OBSERVATIONS,
                sends: [
                    { ...SEND, msgId: 'a1', seq: 1, expectedRecipientPeerIds: recipients },
                    { ...SEND, msgId: 'a2', seq: 2, expectedRecipientPeerIds: recipients }
                ],
                arrivals: [
                    { msgId: 'a2', recipientPeerId: 'reads-second-first', atMs: 10 },
                    { msgId: 'a1', recipientPeerId: 'reads-second-first', atMs: 10 },
                    { msgId: 'a1', recipientPeerId: 'reads-in-order', atMs: 10 },
                    { msgId: 'a2', recipientPeerId: 'reads-in-order', atMs: 10 }
                ]
            });

            expect(report.delivery.copiesReadOutOfTrackOrder).toBe(1);
        });

        it('counts every copy read before a lower seq as out of order when the first of a track is read last', () => {
            const report = computeOrderedSendReport({
                ...NO_OBSERVATIONS,
                sends: [
                    { ...SEND, msgId: 'a1', seq: 1, expectedRecipientPeerIds: ['recipient-1'] },
                    { ...SEND, msgId: 'a2', seq: 2, expectedRecipientPeerIds: ['recipient-1'] },
                    { ...SEND, msgId: 'a3', seq: 3, expectedRecipientPeerIds: ['recipient-1'] },
                    { ...SEND, msgId: 'a4', seq: 4, expectedRecipientPeerIds: ['recipient-1'] }
                ],
                arrivals: [
                    { msgId: 'a2', recipientPeerId: 'recipient-1', atMs: 10 },
                    { msgId: 'a3', recipientPeerId: 'recipient-1', atMs: 11 },
                    { msgId: 'a4', recipientPeerId: 'recipient-1', atMs: 12 },
                    { msgId: 'a1', recipientPeerId: 'recipient-1', atMs: 13 }
                ]
            });

            expect(report.delivery.copiesReadOutOfTrackOrder).toBe(3);
        });

        it('counts one copy as out of order when the last of a track is read first', () => {
            const report = computeOrderedSendReport({
                ...NO_OBSERVATIONS,
                sends: [
                    { ...SEND, msgId: 'a1', seq: 1, expectedRecipientPeerIds: ['recipient-1'] },
                    { ...SEND, msgId: 'a2', seq: 2, expectedRecipientPeerIds: ['recipient-1'] },
                    { ...SEND, msgId: 'a3', seq: 3, expectedRecipientPeerIds: ['recipient-1'] },
                    { ...SEND, msgId: 'a4', seq: 4, expectedRecipientPeerIds: ['recipient-1'] }
                ],
                arrivals: [
                    { msgId: 'a4', recipientPeerId: 'recipient-1', atMs: 10 },
                    { msgId: 'a1', recipientPeerId: 'recipient-1', atMs: 11 },
                    { msgId: 'a2', recipientPeerId: 'recipient-1', atMs: 12 },
                    { msgId: 'a3', recipientPeerId: 'recipient-1', atMs: 13 }
                ]
            });

            expect(report.delivery.copiesReadOutOfTrackOrder).toBe(1);
        });

        it('counts a copy read while a lower seq the same recipient expected was never read', () => {
            const everyRecipient = ['misses-the-second', 'reads-in-full', 'not-in-the-first-audience'];
            const report = computeOrderedSendReport({
                ...NO_OBSERVATIONS,
                sends: [
                    { ...SEND, msgId: 'a1', seq: 1, expectedRecipientPeerIds: ['misses-the-second', 'reads-in-full'] },
                    { ...SEND, msgId: 'a2', seq: 2, expectedRecipientPeerIds: everyRecipient },
                    { ...SEND, msgId: 'a3', seq: 3, expectedRecipientPeerIds: everyRecipient },
                    { ...SEND, msgId: 'b1', seq: 1, publisherPeerId: 'publisher-2', expectedRecipientPeerIds: everyRecipient },
                    { ...SEND, msgId: 'b2', seq: 2, publisherPeerId: 'publisher-2', expectedRecipientPeerIds: everyRecipient }
                ],
                arrivals: [
                    { msgId: 'a1', recipientPeerId: 'misses-the-second', atMs: 10 },
                    { msgId: 'a1', recipientPeerId: 'reads-in-full', atMs: 11 },
                    { msgId: 'a2', recipientPeerId: 'reads-in-full', atMs: 12 },
                    { msgId: 'a2', recipientPeerId: 'not-in-the-first-audience', atMs: 13 },
                    { msgId: 'a3', recipientPeerId: 'misses-the-second', atMs: 14 },
                    { msgId: 'a3', recipientPeerId: 'reads-in-full', atMs: 15 },
                    { msgId: 'a3', recipientPeerId: 'not-in-the-first-audience', atMs: 16 },
                    { msgId: 'b1', recipientPeerId: 'misses-the-second', atMs: 17 },
                    { msgId: 'b1', recipientPeerId: 'reads-in-full', atMs: 18 },
                    { msgId: 'b2', recipientPeerId: 'misses-the-second', atMs: 19 },
                    { msgId: 'b2', recipientPeerId: 'reads-in-full', atMs: 20 },
                    { msgId: 'b2', recipientPeerId: 'not-in-the-first-audience', atMs: 21 }
                ]
            });

            expect(report.delivery).toMatchObject({
                copiesReadPastAnUnreadPredecessor: 2,
                copiesReadOutOfTrackOrder: 0
            });
        });
    });

    describe('recipient delays', () => {
        it('measures a recipient delay from the send to that recipient\'s first arrival, by nearest rank', () => {
            const twentySends = toSendsReadAfter([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);

            const report = computeOrderedSendReport({
                ...twentySends,
                sends: twentySends.sends.toReversed(),
                arrivals: [
                    ...twentySends.arrivals,
                    { msgId: 'send-1', recipientPeerId: 'recipient-1', atMs: 2_500 }
                ]
            });

            expect(report.recipientDelays).toMatchObject({
                offerToFirstReadMs: { count: 20, p50: 10, p95: 19, p99: 20, max: 20 },
                firstTenSendsP50Ms: 5,
                lastTenSendsP50Ms: 15,
                lastToFirstTenSendsP50Ratio: 3
            });
        });

        it('measures the first read of a copy from its send\'s due time and, apart, from its offer', () => {
            const report = computeOrderedSendReport({
                ...NO_OBSERVATIONS,
                sends: [
                    { ...SEND, msgId: 'late-by-4', dueAtMs: 0, sentAtMs: 4, expectedRecipientPeerIds: ['recipient-1'] },
                    { ...SEND, msgId: 'late-by-1', dueAtMs: 100, sentAtMs: 101, expectedRecipientPeerIds: ['recipient-1'] },
                    { ...SEND, msgId: 'late-by-20', dueAtMs: 200, sentAtMs: 220, expectedRecipientPeerIds: ['recipient-1'] }
                ],
                arrivals: [
                    { msgId: 'late-by-4', recipientPeerId: 'recipient-1', atMs: 10 },
                    { msgId: 'late-by-1', recipientPeerId: 'recipient-1', atMs: 103 },
                    { msgId: 'late-by-20', recipientPeerId: 'recipient-1', atMs: 225 }
                ]
            });

            expect(report.recipientDelays).toMatchObject({
                dueToFirstReadMs: { count: 3, p50: 10, p95: 25, p99: 25, max: 25 },
                dueToFirstReadOverExpectedCopiesMs: { count: 3, p50: 10, p95: 25, p99: 25 },
                offerToFirstReadMs: { count: 3, p50: 5, p95: 6, p99: 6, max: 6 },
                offerToFirstReadOverExpectedCopiesMs: { count: 3, p50: 5, p95: 6, p99: 6 }
            });
        });

        it('sorts first-read delays into the declared buckets and leaves out a copy read before its offer', () => {
            const report = computeOrderedSendReport({
                ...NO_OBSERVATIONS,
                sends: [{
                    ...SEND,
                    msgId: 'send',
                    dueAtMs: 90,
                    sentAtMs: 100,
                    expectedRecipientPeerIds: ['before-the-offer', 'under-1', 'at-5', 'over-5', 'over-every-bound']
                }],
                arrivals: [
                    { msgId: 'send', recipientPeerId: 'before-the-offer', atMs: 99 },
                    { msgId: 'send', recipientPeerId: 'under-1', atMs: 100.5 },
                    { msgId: 'send', recipientPeerId: 'at-5', atMs: 105 },
                    { msgId: 'send', recipientPeerId: 'over-5', atMs: 105.5 },
                    { msgId: 'send', recipientPeerId: 'over-every-bound', atMs: 70_100 }
                ]
            });

            expect(report.recipientDelays.offerToFirstReadMs).toEqual({
                count: 4,
                p50: 5,
                p95: 70_000,
                p99: 70_000,
                max: 70_000,
                histogram: {
                    upperBounds: DELAY_BOUNDS_MS,
                    bucketCounts: [1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
                    count: 4,
                    sum: 70_011,
                    min: 0.5,
                    max: 70_000
                },
                unrecordedSamples: 0
            });
            expect(report.recipientDelays.dueToFirstReadMs).toEqual({
                count: 4,
                p50: 15,
                p95: 70_010,
                p99: 70_010,
                max: 70_010,
                histogram: {
                    upperBounds: DELAY_BOUNDS_MS,
                    bucketCounts: [0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
                    count: 4,
                    sum: 70_051,
                    min: 10.5,
                    max: 70_010
                },
                unrecordedSamples: 0
            });
            expect(report.recipientDelays.copiesReadBeforeTheirOffer).toBe(1);
            expect(report.delivery.copiesRead).toBe(5);
        });

        it('keeps a copy read before its send\'s due time out of the due-time figures only', () => {
            const report = computeOrderedSendReport({
                ...NO_OBSERVATIONS,
                sends: [{ ...SEND, msgId: 'offered-early', dueAtMs: 100, sentAtMs: 98 }],
                arrivals: [
                    { msgId: 'offered-early', recipientPeerId: 'recipient-1', atMs: 99 },
                    { msgId: 'offered-early', recipientPeerId: 'recipient-2', atMs: 104 }
                ]
            });

            expect(report.recipientDelays).toMatchObject({
                dueToFirstReadMs: { count: 1, p50: 4, max: 4, unrecordedSamples: 1 },
                dueToFirstReadOverExpectedCopiesMs: { count: 1, p50: 4, p95: 4, p99: 4 },
                offerToFirstReadMs: { count: 2, p50: 1, max: 6, unrecordedSamples: 0 },
                offerToFirstReadOverExpectedCopiesMs: { count: 2, p50: 1, p95: 6, p99: 6 },
                copiesReadBeforeTheirOffer: 0
            });
        });

        it('ranks a copy never read above every read one and gives no percentile whose rank lands on it', () => {
            const nineteenSends = toSendsReadAfter([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

            const report = computeOrderedSendReport({
                ...nineteenSends,
                sends: [
                    ...nineteenSends.sends,
                    {
                        ...SEND,
                        msgId: 'never-read',
                        seq: 20,
                        dueAtMs: 2_000,
                        sentAtMs: 2_000,
                        expectedRecipientPeerIds: ['recipient-1']
                    }
                ]
            });

            expect(report.recipientDelays.dueToFirstReadMs).toMatchObject({ count: 19, p50: 10, p95: 19, p99: 19 });
            expect(report.recipientDelays.dueToFirstReadOverExpectedCopiesMs)
                .toEqual({ count: 20, p50: 10, p95: 19, p99: null });
            expect(report.recipientDelays.offerToFirstReadOverExpectedCopiesMs)
                .toEqual({ count: 20, p50: 10, p95: 19, p99: null });
        });

        it('gives no ratio when the first sends were read without delay', () => {
            const report = computeOrderedSendReport(
                toSendsReadAfter([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4])
            );

            expect(report.recipientDelays).toMatchObject({
                firstTenSendsP50Ms: 0,
                lastTenSendsP50Ms: 4,
                lastToFirstTenSendsP50Ratio: null
            });
        });

        it('gives no first-ten and last-ten figures under twenty sends, where the two tens would share a send', () => {
            const report = computeOrderedSendReport(
                toSendsReadAfter([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
            );

            expect(report.recipientDelays).toMatchObject({
                dueToFirstReadMs: { count: 19, p50: 10 },
                firstTenSendsP50Ms: null,
                lastTenSendsP50Ms: null,
                lastToFirstTenSendsP50Ratio: null
            });
        });

        it('takes the first ten and the last ten sends, each with the copies of both its recipients, from their due times', () => {
            const delaysMsOfEachSend = [
                [1, 11],
                [2, 12],
                [3, 13],
                [4, 14],
                [5, 15],
                [6, 16],
                [7, 17],
                [8, 18],
                [9, 19],
                [10, 20],
                [3, 33],
                [6, 36],
                [9, 39],
                [12, 42],
                [15, 45],
                [18, 48],
                [21, 51],
                [24, 54],
                [27, 57],
                [30, 60]
            ];

            const report = computeOrderedSendReport({
                ...NO_OBSERVATIONS,
                sends: delaysMsOfEachSend.map((_, index) => ({
                    ...SEND,
                    msgId: `send-${index + 1}`,
                    seq: index + 1,
                    dueAtMs: (index + 1) * 100,
                    sentAtMs: (index + 1) * 100 + 0.5
                })),
                arrivals: delaysMsOfEachSend.flatMap(([firstDelayMs, secondDelayMs], index) => [
                    { msgId: `send-${index + 1}`, recipientPeerId: 'recipient-1', atMs: (index + 1) * 100 + firstDelayMs },
                    { msgId: `send-${index + 1}`, recipientPeerId: 'recipient-2', atMs: (index + 1) * 100 + secondDelayMs }
                ])
            });

            expect(report.recipientDelays).toMatchObject({
                dueToFirstReadMs: { count: 40 },
                firstTenSendsP50Ms: 10,
                lastTenSendsP50Ms: 30,
                lastToFirstTenSendsP50Ratio: 3
            });
        });

        it('gives no last-ten figure when most copies of the last ten sends were never read', () => {
            const fourteenSends = toSendsReadAfter([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 7, 7, 7, 7]);

            const report = computeOrderedSendReport({
                ...fourteenSends,
                sends: [
                    ...fourteenSends.sends,
                    ...[15, 16, 17, 18, 19, 20].map((seq) => ({
                        ...SEND,
                        msgId: `send-${seq}`,
                        seq,
                        dueAtMs: seq * 100,
                        sentAtMs: seq * 100,
                        expectedRecipientPeerIds: ['recipient-1']
                    }))
                ]
            });

            expect(report.recipientDelays).toMatchObject({
                firstTenSendsP50Ms: 5,
                lastTenSendsP50Ms: null,
                lastToFirstTenSendsP50Ratio: null
            });
        });
    });

    describe('receipts', () => {
        it('counts a receipt by its send\'s first terminal phase, times that phase alone, and does not take admitted for one', () => {
            const report = computeOrderedSendReport({
                ...NO_OBSERVATIONS,
                sends: [
                    { ...SEND, msgId: 'completed', sentAtMs: 0 },
                    { ...SEND, msgId: 'timed-out', sentAtMs: 100 },
                    { ...SEND, msgId: 'admitted-only', sentAtMs: 200 },
                    { ...SEND, msgId: 'no-receipt', sentAtMs: 300 },
                    { ...SEND, msgId: 'completed-then-timed-out', sentAtMs: 400 },
                    { ...SEND, msgId: 'timed-out-then-completed', sentAtMs: 500 }
                ],
                receipts: [
                    { msgId: 'completed', phase: 'admitted', atMs: 5 },
                    { msgId: 'completed', phase: 'complete', atMs: 30 },
                    { msgId: 'timed-out', phase: 'admitted', atMs: 106 },
                    { msgId: 'admitted-only', phase: 'admitted', atMs: 207 },
                    { msgId: 'completed-then-timed-out', phase: 'admitted', atMs: 409 },
                    { msgId: 'completed-then-timed-out', phase: 'complete', atMs: 440 },
                    { msgId: 'timed-out', phase: 'timed-out', atMs: 30_100 },
                    { msgId: 'completed-then-timed-out', phase: 'timed-out', atMs: 30_400 },
                    { msgId: 'timed-out-then-completed', phase: 'admitted', atMs: 508 },
                    { msgId: 'timed-out-then-completed', phase: 'timed-out', atMs: 30_520 },
                    { msgId: 'timed-out-then-completed', phase: 'complete', atMs: 30_530 }
                ]
            });

            expect(report.receipts).toMatchObject({
                expected: 6,
                complete: 2,
                timedOut: 2,
                admittedWithoutTerminal: 1,
                noReceipt: 1,
                moreThanOneTerminal: 2,
                offerToAdmittedMs: { count: 5, p50: 7, p95: 9, p99: 9, max: 9 },
                offerToCompleteMs: { count: 2, p50: 30, p95: 40, p99: 40, max: 40 },
                offerToTimedOutMs: { count: 2, p50: 30_000, p95: 30_020, p99: 30_020, max: 30_020 }
            });
            const { complete, timedOut, admittedWithoutTerminal, noReceipt } = report.receipts;
            expect(complete + timedOut + admittedWithoutTerminal + noReceipt).toBe(report.receipts.expected);
        });

        it('counts a receipt read again apart, and takes each state and each delay from the first read of its phase', () => {
            const report = computeOrderedSendReport({
                ...NO_OBSERVATIONS,
                sends: [
                    { ...SEND, msgId: 'both-read-twice', sentAtMs: 0 },
                    { ...SEND, msgId: 'each-read-once', sentAtMs: 100 },
                    { ...SEND, msgId: 'admitted-read-twice', sentAtMs: 200 },
                    { ...SEND, msgId: 'admitted-read-last', sentAtMs: 300 }
                ],
                receipts: [
                    { msgId: 'both-read-twice', phase: 'admitted', atMs: 4 },
                    { msgId: 'both-read-twice', phase: 'complete', atMs: 50 },
                    { msgId: 'both-read-twice', phase: 'admitted', atMs: 60 },
                    { msgId: 'both-read-twice', phase: 'complete', atMs: 70 },
                    { msgId: 'each-read-once', phase: 'admitted', atMs: 103 },
                    { msgId: 'each-read-once', phase: 'complete', atMs: 120 },
                    { msgId: 'admitted-read-twice', phase: 'admitted', atMs: 205 },
                    { msgId: 'admitted-read-twice', phase: 'admitted', atMs: 215 },
                    { msgId: 'admitted-read-last', phase: 'complete', atMs: 330 },
                    { msgId: 'admitted-read-last', phase: 'admitted', atMs: 340 }
                ]
            });

            expect(report.receipts).toMatchObject({
                expected: 4,
                complete: 3,
                timedOut: 0,
                admittedWithoutTerminal: 1,
                noReceipt: 0,
                moreThanOneTerminal: 1,
                sendsWithARepeatedAdmittedReceipt: 2,
                sendsWithAnAdmittedAfterTheirTerminal: 2,
                offerToAdmittedMs: { count: 4, p50: 4, p95: 40, p99: 40, max: 40 },
                offerToCompleteMs: { count: 3, p50: 30, p95: 50, p99: 50, max: 50 }
            });
        });

        it('expects a receipt of the sends the entry accepted only, so a rejected send is not one without a receipt', () => {
            const report = computeOrderedSendReport({
                ...NO_OBSERVATIONS,
                sends: [
                    { ...SEND, msgId: 'admitted', sentAtMs: 0 },
                    { ...SEND, msgId: 'pending-admission', sentAtMs: 100, acceptance: 'pending-admission' },
                    {
                        ...SEND,
                        msgId: 'rejected',
                        sentAtMs: 200,
                        acceptance: 'rejected',
                        rejectionCode: 'unauthorized'
                    },
                    {
                        ...SEND,
                        msgId: 'not-admitted',
                        sentAtMs: 300,
                        acceptance: 'not-admitted',
                        notAdmittedReason: 'expired'
                    },
                    { ...SEND, msgId: 'unanswered', sentAtMs: 400, acceptance: 'unanswered', answeredAtMs: null }
                ],
                receipts: [
                    { msgId: 'admitted', phase: 'admitted', atMs: 3 },
                    { msgId: 'admitted', phase: 'complete', atMs: 20 },
                    { msgId: 'pending-admission', phase: 'admitted', atMs: 110 }
                ]
            });

            expect(report.receipts).toMatchObject({
                expected: 2,
                complete: 1,
                timedOut: 0,
                admittedWithoutTerminal: 1,
                noReceipt: 0,
                moreThanOneTerminal: 0
            });
        });
    });

    describe('controls', () => {
        it('counts the NACKs and the repair requests of known sends by type and by reason, and the sends that drew one', () => {
            const report = computeOrderedSendReport({
                ...NO_OBSERVATIONS,
                sends: [
                    { ...SEND, msgId: 'repaired', seq: 1 },
                    { ...SEND, msgId: 'revealed-a-gap', seq: 2 },
                    { ...SEND, msgId: 'refused', seq: 3 },
                    { ...SEND, msgId: 'drew-nothing', seq: 4 }
                ],
                controls: [
                    { type: 'nack', msgId: 'revealed-a-gap', reason: 'gap', atMs: 10 },
                    { type: 'nack', msgId: 'revealed-a-gap', reason: 'gap', atMs: 20 },
                    { type: 'repair', msgId: 'revealed-a-gap', reason: 'missing-seq', atMs: 21 },
                    { type: 'repair', msgId: 'repaired', reason: 'retransmit', atMs: 30 },
                    { type: 'repair', msgId: 'repaired', reason: 'missing-seq', atMs: 31 },
                    { type: 'nack', msgId: 'refused', reason: 'expired', atMs: 40 },
                    { type: 'nack', msgId: 'unknown', reason: 'gap', atMs: 50 },
                    { type: 'repair', msgId: 'unknown', reason: 'resync', atMs: 51 }
                ]
            });

            expect(report.controls).toEqual({
                byType: { nack: 3, repair: 3 },
                nacksByReason: { ...NO_NACKS_BY_REASON, gap: 2, expired: 1 },
                repairsByReason: { 'missing-seq': 2, retransmit: 1, resync: 0 },
                sendsWithANack: 2,
                sendsWithARepairRequest: 2
            });
            expect(report.unmatched.controlsOfUnknownMessage).toBe(2);
        });
    });

    describe('what matches no send', () => {
        it('counts apart whatever matched no send, no expected recipient or no accepted send, and drops none of it', () => {
            const controlsOfUnknownMessages: readonly OrderedSendCellControl[] = [31, 32, 33, 34, 35, 36, 37]
                .map((atMs) => ({ type: 'repair', msgId: 'unknown-1', reason: 'missing-seq', atMs }));
            const report = computeOrderedSendReport({
                ...NO_OBSERVATIONS,
                sends: [
                    { ...SEND, msgId: 'known', seq: 1 },
                    { ...SEND, msgId: 'known', seq: 2, expectedRecipientPeerIds: ['recipient-3'] },
                    {
                        ...SEND,
                        msgId: 'rejected',
                        seq: 3,
                        acceptance: 'rejected',
                        rejectionCode: 'unauthorized',
                        expectedRecipientPeerIds: ['recipient-1']
                    }
                ],
                arrivals: [
                    { msgId: 'known', recipientPeerId: 'recipient-1', atMs: 10 },
                    { msgId: 'known', recipientPeerId: 'recipient-3', atMs: 11 },
                    { msgId: 'known', recipientPeerId: 'stranger', atMs: 12 },
                    { msgId: 'rejected', recipientPeerId: 'recipient-2', atMs: 13 },
                    { msgId: 'unknown-1', recipientPeerId: 'recipient-1', atMs: 14 },
                    { msgId: 'unknown-1', recipientPeerId: 'recipient-2', atMs: 15 },
                    { msgId: 'unknown-2', recipientPeerId: 'recipient-1', atMs: 16 },
                    { msgId: 'unknown-2', recipientPeerId: 'stranger', atMs: 17 }
                ],
                handOffs: [
                    { msgId: 'known', instanceIndex: 0, atMs: 5 },
                    { msgId: 'unknown-1', instanceIndex: 0, atMs: 6 },
                    { msgId: 'unknown-1', instanceIndex: 1, atMs: 7 },
                    { msgId: 'unknown-1', instanceIndex: 2, atMs: 8 },
                    { msgId: 'unknown-2', instanceIndex: 0, atMs: 9 },
                    { msgId: 'unknown-2', instanceIndex: 0, atMs: 9.5 }
                ],
                receipts: [
                    { msgId: 'known', phase: 'admitted', atMs: 3 },
                    { msgId: 'rejected', phase: 'admitted', atMs: 4 },
                    { msgId: 'rejected', phase: 'complete', atMs: 20 },
                    { msgId: 'unknown-1', phase: 'admitted', atMs: 21 },
                    { msgId: 'unknown-1', phase: 'complete', atMs: 22 },
                    { msgId: 'unknown-2', phase: 'admitted', atMs: 23 },
                    { msgId: 'unknown-2', phase: 'complete', atMs: 24 },
                    { msgId: 'unknown-3', phase: 'admitted', atMs: 25 },
                    { msgId: 'unknown-3', phase: 'timed-out', atMs: 26 }
                ],
                controls: [{ type: 'nack', msgId: 'known', reason: 'gap', atMs: 30 }, ...controlsOfUnknownMessages],
                unclassifiedControls: [41, 42, 43, 44, 45, 46, 47, 48]
                    .map((atMs) => ({ typeId: 'al.control.ack.v3', atMs }))
            });

            expect(report.unmatched).toEqual({
                sendsWithARepeatedMsgId: 1,
                receiptsOfASendNotAccepted: 2,
                arrivalsAtUnexpectedRecipient: 3,
                arrivalsOfUnknownMessage: 4,
                handOffsOfUnknownMessage: 5,
                receiptsOfUnknownMessage: 6,
                controlsOfUnknownMessage: 7,
                unclassifiedControls: 8
            });
            expect(report.sends.attempted).toBe(2);
            expect(report.delivery).toMatchObject({ handedToApplication: 1, copiesExpected: 3, copiesRead: 1 });
            expect(report.receipts).toMatchObject({ expected: 1, admittedWithoutTerminal: 1 });
            expect(report.controls).toMatchObject({ byType: { nack: 1, repair: 0 }, sendsWithANack: 1 });
        });
    });

    it('reports zero counts and null figures for no observations', () => {
        expect(computeOrderedSendReport(NO_OBSERVATIONS)).toEqual({
            sends: {
                attempted: 0,
                byAcceptance: {
                    admitted: 0,
                    duplicate: 0,
                    'resync-required': 0,
                    disposed: 0,
                    'pending-admission': 0,
                    'not-admitted': 0,
                    control: 0,
                    rejected: 0,
                    unanswered: 0
                },
                rejectedByCode: { malformed: 0, oversized: 0, unauthorized: 0, unsupported: 0 },
                notAdmittedByReason: {},
                latenessMs: NO_SAMPLES,
                offerToAnswerMs: NO_SAMPLES
            },
            delivery: {
                handedToApplication: 0,
                handedMoreThanOnce: 0,
                handedByMoreThanOneInstance: 0,
                largestHandOffMultiplicity: null,
                offerToFirstHandOffMs: NO_SAMPLES,
                deliveredToEveryRecipient: 0,
                deliveredToAnyRecipient: 0,
                copiesExpected: 0,
                copiesRead: 0,
                copiesReadMoreThanOnce: 0,
                copiesReadOutOfTrackOrder: 0,
                copiesReadPastAnUnreadPredecessor: 0
            },
            recipientDelays: {
                dueToFirstReadMs: NO_SAMPLES,
                dueToFirstReadOverExpectedCopiesMs: { count: 0, p50: null, p95: null, p99: null },
                offerToFirstReadMs: NO_SAMPLES,
                offerToFirstReadOverExpectedCopiesMs: { count: 0, p50: null, p95: null, p99: null },
                copiesReadBeforeTheirOffer: 0,
                firstTenSendsP50Ms: null,
                lastTenSendsP50Ms: null,
                lastToFirstTenSendsP50Ratio: null
            },
            receipts: {
                expected: 0,
                complete: 0,
                timedOut: 0,
                admittedWithoutTerminal: 0,
                noReceipt: 0,
                moreThanOneTerminal: 0,
                sendsWithARepeatedAdmittedReceipt: 0,
                sendsWithAnAdmittedAfterTheirTerminal: 0,
                offerToAdmittedMs: NO_SAMPLES,
                offerToCompleteMs: NO_SAMPLES,
                offerToTimedOutMs: NO_SAMPLES
            },
            controls: {
                byType: { nack: 0, repair: 0 },
                nacksByReason: NO_NACKS_BY_REASON,
                repairsByReason: { 'missing-seq': 0, retransmit: 0, resync: 0 },
                sendsWithANack: 0,
                sendsWithARepairRequest: 0
            },
            unmatched: {
                sendsWithARepeatedMsgId: 0,
                arrivalsOfUnknownMessage: 0,
                arrivalsAtUnexpectedRecipient: 0,
                handOffsOfUnknownMessage: 0,
                receiptsOfUnknownMessage: 0,
                receiptsOfASendNotAccepted: 0,
                controlsOfUnknownMessage: 0,
                unclassifiedControls: 0
            }
        });
    });
});
