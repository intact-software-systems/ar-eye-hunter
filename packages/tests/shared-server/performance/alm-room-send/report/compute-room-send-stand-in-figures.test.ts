import { describe, expect, it } from 'vitest';

import { computeRoomSendReport } from '../../../../../../apps/api-v1/scripts/perf/alm-room-send/report/compute-room-send-report.ts';
import type {
    RoomSendCellObservations,
    RoomSendCellSend
} from '../../../../../../apps/api-v1/scripts/perf/alm-room-send/room-send-cell-observations.ts';

function toSend(seq: number): RoomSendCellSend {
    return {
        msgId: `send-${seq}`,
        publisherPeerId: 'publisher-1',
        seq,
        dueAtMs: seq * 100,
        sentAtMs: seq * 100,
        answeredAtMs: seq * 100 + 1,
        acceptance: 'admitted',
        expectedRecipientPeerIds: ['recipient-1']
    };
}

/** Five sends of one publisher, and what its stand-in ended and declined of them and of two sends the cell never offered. */
const OBSERVATIONS: RoomSendCellObservations = {
    ordering: 'ordering-key',
    sends: [1, 2, 3, 4, 5].map(toSend),
    resends: [],
    acks: [],
    arrivals: [],
    handOffs: [],
    receipts: [],
    controls: [],
    unclassifiedControls: [],
    sendEnds: [
        { msgId: 'send-1', cause: 'first-hop-exhausted', atMs: 8_100 },
        { msgId: 'send-2', cause: 'terminal-receipt', atMs: 900 },
        { msgId: 'send-3', cause: 'terminal-receipt', atMs: 30_400 },
        { msgId: 'send-4', cause: 'expired', atMs: 30_410 },
        { msgId: 'unknown-1', cause: 'expired', atMs: 30_420 },
        { msgId: 'unknown-2', cause: 'repair-budget-spent', atMs: 30_430 }
    ],
    declinedRepairs: [
        { msgId: 'send-1', reason: 'send-ended', atMs: 9_000 },
        { msgId: 'send-1', reason: 'send-ended', atMs: 9_500 },
        { msgId: 'send-4', reason: 'send-expired', atMs: 30_405 },
        { msgId: 'send-5', reason: 'named-send-expired', atMs: 31_000 },
        { msgId: 'unknown-1', reason: 'send-ended', atMs: 31_001 },
        { msgId: 'unknown-1', reason: 'send-ended', atMs: 31_002 },
        { msgId: 'unknown-1', reason: 'send-ended', atMs: 31_003 }
    ],
    observationEndedAtMs: 95_000
};

describe('computeRoomSendReport: what the stand-in ended and declined', () => {
    it('counts the sends the stand-in ended by cause and the repairs it declined by reason, over the sends the cell knows', () => {
        expect(computeRoomSendReport(OBSERVATIONS).standIn).toEqual({
            sendsEnded: 4,
            endsByCause: {
                'first-hop-exhausted': 1,
                'terminal-receipt': 2,
                'terminal-nack': 0,
                'repair-budget-spent': 0,
                expired: 1
            },
            repairsDeclined: 4,
            repairsDeclinedByReason: { 'send-ended': 2, 'send-expired': 1, 'named-send-expired': 1 }
        });
    });

    it('counts apart an end and a declined repair that name no send of the run, and drops neither', () => {
        expect(computeRoomSendReport(OBSERVATIONS).unmatched).toMatchObject({
            sendEndsOfUnknownMessage: 2,
            declinedRepairsOfUnknownMessage: 3
        });
    });
});
