import { describe, expect, it } from 'vitest';

import { computeRoomSendReport } from '../../../../../../apps/api-v1/scripts/perf/alm-room-send/report/compute-room-send-report.ts';
import type {
    RoomSendCellAnswer,
    RoomSendCellObservations,
    RoomSendCellOffer
} from '../../../../../../apps/api-v1/scripts/perf/alm-room-send/room-send-cell-observations.ts';

const NO_ORDERED_OBSERVATIONS: RoomSendCellObservations = {
    ordering: 'ordering-key',
    sends: [],
    resends: [],
    acks: [],
    arrivals: [],
    handOffs: [],
    receipts: [],
    controls: [],
    unclassifiedControls: [],
    sendEnds: [],
    declinedRepairs: [],
    observationEndedAtMs: 0
};

const SEND = {
    publisherPeerId: 'publisher-1',
    seq: 1,
    dueAtMs: 0,
    sentAtMs: 0,
    answeredAtMs: 1,
    acceptance: 'admitted',
    expectedRecipientPeerIds: ['recipient-1']
} satisfies Omit<RoomSendCellOffer, 'msgId'> & RoomSendCellAnswer;

describe('computeRoomSendReport: the figures of a track', () => {
    it('reports the track figures of unordered sends as not applicable, never as zeros', () => {
        const report = computeRoomSendReport({
            ...NO_ORDERED_OBSERVATIONS,
            ordering: 'unordered',
            sends: [
                { ...SEND, msgId: 'never-written', seq: 1 },
                { ...SEND, msgId: 'written', seq: 2 }
            ],
            arrivals: [{ msgId: 'written', recipientPeerId: 'recipient-1', atMs: 10, namesOrderingKey: false }],
            controls: [{ type: 'repair', msgId: 'written', reason: 'retransmit', atMs: 20 }]
        });

        expect(report.tracks).toEqual({ kind: 'not-applicable' });
        expect(report.delivery).not.toHaveProperty('copiesReadPastAnUnreadPredecessor');
        expect(report).not.toHaveProperty('beforeFirstControl');
        // What the two figures would have said is still in the report, under figures that hold for every send.
        expect(report.delivery).toMatchObject({ copiesExpected: 2, copiesRead: 1, copiesReadOutOfOfferOrder: 0 });
        expect(report.controls.repairsByReason.retransmit).toBe(1);
    });

    it('counts a copy read while a lower seq the same recipient expected was never read', () => {
        const everyRecipient = ['misses-the-second', 'reads-in-full', 'not-in-the-first-audience'];
        const report = computeRoomSendReport({
            ...NO_ORDERED_OBSERVATIONS,
            sends: [
                { ...SEND, msgId: 'a1', seq: 1, expectedRecipientPeerIds: ['misses-the-second', 'reads-in-full'] },
                { ...SEND, msgId: 'a2', seq: 2, expectedRecipientPeerIds: everyRecipient },
                { ...SEND, msgId: 'a3', seq: 3, expectedRecipientPeerIds: everyRecipient },
                { ...SEND, msgId: 'b1', seq: 1, publisherPeerId: 'publisher-2', expectedRecipientPeerIds: everyRecipient },
                { ...SEND, msgId: 'b2', seq: 2, publisherPeerId: 'publisher-2', expectedRecipientPeerIds: everyRecipient }
            ],
            arrivals: [
                { msgId: 'a1', recipientPeerId: 'misses-the-second', atMs: 10, namesOrderingKey: true },
                { msgId: 'a1', recipientPeerId: 'reads-in-full', atMs: 11, namesOrderingKey: true },
                { msgId: 'a2', recipientPeerId: 'reads-in-full', atMs: 12, namesOrderingKey: true },
                { msgId: 'a2', recipientPeerId: 'not-in-the-first-audience', atMs: 13, namesOrderingKey: true },
                { msgId: 'a3', recipientPeerId: 'misses-the-second', atMs: 14, namesOrderingKey: true },
                { msgId: 'a3', recipientPeerId: 'reads-in-full', atMs: 15, namesOrderingKey: true },
                { msgId: 'a3', recipientPeerId: 'not-in-the-first-audience', atMs: 16, namesOrderingKey: true },
                { msgId: 'b1', recipientPeerId: 'misses-the-second', atMs: 17, namesOrderingKey: true },
                { msgId: 'b1', recipientPeerId: 'reads-in-full', atMs: 18, namesOrderingKey: true },
                { msgId: 'b2', recipientPeerId: 'misses-the-second', atMs: 19, namesOrderingKey: true },
                { msgId: 'b2', recipientPeerId: 'reads-in-full', atMs: 20, namesOrderingKey: true },
                { msgId: 'b2', recipientPeerId: 'not-in-the-first-audience', atMs: 21, namesOrderingKey: true }
            ]
        });

        expect(report.tracks).toMatchObject({ kind: 'ordering-key', copiesReadPastAnUnreadPredecessor: 2 });
        expect(report.delivery.copiesReadOutOfOfferOrder).toBe(0);
    });

    it('takes of each track the sends offered before its publisher read the track\'s first NACK or repair request', () => {
        const toSend = (publisherPeerId: string, seq: number, sentAtMs: number) => ({
            ...SEND,
            msgId: `${publisherPeerId}-send-${seq}`,
            publisherPeerId,
            seq,
            dueAtMs: sentAtMs,
            sentAtMs,
            answeredAtMs: sentAtMs + 1
        });
        const report = computeRoomSendReport({
            ...NO_ORDERED_OBSERVATIONS,
            sends: [
                toSend('publisher-1', 1, 100),
                toSend('publisher-2', 1, 150),
                toSend('publisher-1', 2, 200),
                toSend('publisher-2', 2, 250),
                toSend('publisher-1', 3, 300),
                toSend('publisher-1', 4, 400)
            ],
            arrivals: [
                { msgId: 'publisher-1-send-1', recipientPeerId: 'recipient-1', atMs: 130, namesOrderingKey: true },
                { msgId: 'publisher-2-send-1', recipientPeerId: 'recipient-1', atMs: 190, namesOrderingKey: true },
                { msgId: 'publisher-1-send-2', recipientPeerId: 'recipient-1', atMs: 260, namesOrderingKey: true },
                { msgId: 'publisher-2-send-2', recipientPeerId: 'recipient-1', atMs: 270, namesOrderingKey: true },
                { msgId: 'publisher-1-send-4', recipientPeerId: 'recipient-1', atMs: 420, namesOrderingKey: true }
            ],
            controls: [
                { type: 'nack', msgId: 'unknown', reason: 'gap', atMs: 120 },
                { type: 'nack', msgId: 'publisher-1-send-3', reason: 'gap', atMs: 350 },
                { type: 'repair', msgId: 'publisher-1-send-3', reason: 'missing-seq', atMs: 351 },
                { type: 'nack', msgId: 'publisher-1-send-4', reason: 'gap', atMs: 410 }
            ]
        });

        // In the view: the first three sends of publisher 1, the third never read, and both of publisher 2. The
        // four first reads took 30, 40, 60 and 20 ms from their due times. Past the unread third send of
        // publisher 1, its recipient read the fourth.
        expect(report.tracks).toEqual({
            kind: 'ordering-key',
            copiesReadPastAnUnreadPredecessor: 1,
            beforeFirstControl: {
                tracksWithAControl: 1,
                sends: 5,
                copiesExpected: 5,
                copiesRead: 4,
                dueToFirstReadOverExpectedCopiesMs: { count: 5, p50: 40, p95: null, p99: null }
            }
        });
        expect(report.delivery).toMatchObject({ copiesExpected: 6, copiesRead: 5 });
    });
});
