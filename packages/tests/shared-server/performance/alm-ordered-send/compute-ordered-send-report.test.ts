import { describe, expect, it } from 'vitest';

import { computeOrderedSendReport } from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/compute-ordered-send-report.ts';
import type {
    OrderedSendCellObservations,
    OrderedSendCellSend
} from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/ordered-send-cell-observations.ts';

const NO_OBSERVATIONS: OrderedSendCellObservations = { sends: [], arrivals: [], handOffs: [], receipts: [] };

const SEND: Omit<OrderedSendCellSend, 'msgId'> = {
    publisherPeerId: 'publisher-1',
    seq: 1,
    dueAtMs: 0,
    sentAtMs: 0,
    answeredAtMs: 1,
    acceptance: 'admitted',
    expectedRecipientPeerIds: ['recipient-1', 'recipient-2']
};

const NO_SAMPLES = { count: 0, p50: null, p95: null, p99: null, max: null };

const DELAY_BOUNDS_MS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 60_000];

/** One send to one recipient for each delay, a tenth of a second apart, read that long after it was sent. */
function toSendsReadAfter(delaysMs: readonly number[]): OrderedSendCellObservations {
    return {
        ...NO_OBSERVATIONS,
        sends: delaysMs.map((_, index) => ({
            ...SEND,
            msgId: `send-${index + 1}`,
            seq: index + 1,
            sentAtMs: (index + 1) * 100,
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

    it('counts sends by how the entry answered them and measures how late each left against its due time', () => {
        const report = computeOrderedSendReport({
            ...NO_OBSERVATIONS,
            sends: [
                { ...SEND, msgId: 'on-time', dueAtMs: 500, sentAtMs: 500 },
                { ...SEND, msgId: 'late-by-2', dueAtMs: 0, sentAtMs: 2 },
                { ...SEND, msgId: 'late-by-7', dueAtMs: 1_000, sentAtMs: 1_007, acceptance: 'pending-admission' },
                { ...SEND, msgId: 'late-by-1', dueAtMs: 1_500, sentAtMs: 1_501, acceptance: 'rejected' }
            ]
        });

        expect(report.sends).toEqual({
            attempted: 4,
            byAcceptance: {
                admitted: 2,
                duplicate: 0,
                'resync-required': 0,
                disposed: 0,
                'pending-admission': 1,
                'not-admitted': 0,
                control: 0,
                rejected: 1
            },
            latenessMs: { count: 4, p50: 1, p95: 7, p99: 7, max: 7 }
        });
    });

    it('measures a recipient delay from the send to that recipient\'s first arrival, by nearest rank', () => {
        const twentySends = toSendsReadAfter([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);

        const report = computeOrderedSendReport({
            ...twentySends,
            sends: [...twentySends.sends].reverse(),
            arrivals: [
                { msgId: 'send-1', recipientPeerId: 'recipient-1', atMs: 600 },
                ...twentySends.arrivals
            ]
        });

        expect(report.recipientDelayMs).toMatchObject({
            count: 20,
            p50: 10,
            p95: 19,
            p99: 20,
            max: 20,
            firstTenSendsP50: 5,
            lastTenSendsP50: 15,
            lastToFirstTenSendsP50Ratio: 3
        });
    });

    it('gives no ratio when the first sends were read without delay', () => {
        const report = computeOrderedSendReport(
            toSendsReadAfter([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4])
        );

        expect(report.recipientDelayMs).toMatchObject({
            firstTenSendsP50: 0,
            lastTenSendsP50: 4,
            lastToFirstTenSendsP50Ratio: null
        });
    });

    it('sorts recipient delays into the declared buckets and counts the one a histogram cannot hold', () => {
        const report = computeOrderedSendReport({
            ...NO_OBSERVATIONS,
            sends: [{
                ...SEND,
                msgId: 'send',
                sentAtMs: 100,
                expectedRecipientPeerIds: ['under-1', 'at-5', 'over-5', 'over-every-bound', 'before-the-send']
            }],
            arrivals: [
                { msgId: 'send', recipientPeerId: 'under-1', atMs: 100.5 },
                { msgId: 'send', recipientPeerId: 'at-5', atMs: 105 },
                { msgId: 'send', recipientPeerId: 'over-5', atMs: 105.5 },
                { msgId: 'send', recipientPeerId: 'over-every-bound', atMs: 70_100 },
                { msgId: 'send', recipientPeerId: 'before-the-send', atMs: 99 }
            ]
        });

        expect(report.recipientDelayMs.histogram).toEqual({
            upperBounds: DELAY_BOUNDS_MS,
            bucketCounts: [1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
            count: 4,
            sum: 70_011,
            min: 0.5,
            max: 70_000
        });
        expect(report.recipientDelayMs.unrecordedSamples).toBe(1);
    });

    it('counts a receipt by its send\'s first terminal phase and does not take admitted for one', () => {
        const report = computeOrderedSendReport({
            ...NO_OBSERVATIONS,
            sends: [
                { ...SEND, msgId: 'completed', sentAtMs: 0 },
                { ...SEND, msgId: 'timed-out', sentAtMs: 100 },
                { ...SEND, msgId: 'admitted-only', sentAtMs: 200 },
                { ...SEND, msgId: 'no-receipt', sentAtMs: 300 },
                { ...SEND, msgId: 'completed-then-timed-out', sentAtMs: 400 }
            ],
            receipts: [
                { msgId: 'completed-then-timed-out', phase: 'timed-out', atMs: 30_400 },
                { msgId: 'completed', phase: 'admitted', atMs: 5 },
                { msgId: 'completed', phase: 'complete', atMs: 30 },
                { msgId: 'timed-out', phase: 'admitted', atMs: 106 },
                { msgId: 'timed-out', phase: 'timed-out', atMs: 30_100 },
                { msgId: 'admitted-only', phase: 'admitted', atMs: 207 },
                { msgId: 'completed-then-timed-out', phase: 'admitted', atMs: 409 },
                { msgId: 'completed-then-timed-out', phase: 'complete', atMs: 440 }
            ]
        });

        expect(report.receipts).toEqual({
            complete: 2,
            timedOut: 1,
            other: 2,
            moreThanOneTerminal: 1,
            sendToAdmittedMs: { count: 4, p50: 6, p95: 9, p99: 9, max: 9 },
            sendToTerminalMs: { count: 3, p50: 40, p95: 30_000, p99: 30_000, max: 30_000 }
        });
    });

    it('counts a message handed to the application more than once and a copy read more than once', () => {
        const report = computeOrderedSendReport({
            ...NO_OBSERVATIONS,
            sends: [
                { ...SEND, msgId: 'handed-once', seq: 1 },
                { ...SEND, msgId: 'handed-twice', seq: 2 },
                { ...SEND, msgId: 'handed-three-times', seq: 3 },
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
            largestHandOffMultiplicity: 3,
            copiesRead: 3,
            copiesReadMoreThanOnce: 1
        });
    });

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
                    rejected: 0
                },
                latenessMs: NO_SAMPLES
            },
            delivery: {
                handedToApplication: 0,
                handedMoreThanOnce: 0,
                largestHandOffMultiplicity: null,
                deliveredToEveryRecipient: 0,
                deliveredToAnyRecipient: 0,
                copiesExpected: 0,
                copiesRead: 0,
                copiesReadMoreThanOnce: 0,
                copiesReadOutOfTrackOrder: 0
            },
            recipientDelayMs: {
                ...NO_SAMPLES,
                firstTenSendsP50: null,
                lastTenSendsP50: null,
                lastToFirstTenSendsP50Ratio: null,
                histogram: {
                    upperBounds: DELAY_BOUNDS_MS,
                    bucketCounts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
                    count: 0,
                    sum: 0,
                    min: null,
                    max: null
                },
                unrecordedSamples: 0
            },
            receipts: {
                complete: 0,
                timedOut: 0,
                other: 0,
                moreThanOneTerminal: 0,
                sendToAdmittedMs: NO_SAMPLES,
                sendToTerminalMs: NO_SAMPLES
            }
        });
    });
});
