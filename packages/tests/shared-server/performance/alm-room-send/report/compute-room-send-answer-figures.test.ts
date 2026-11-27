import { describe, expect, it } from 'vitest';

import { computeRoomSendReport } from '../../../../../../apps/api-v1/scripts/perf/alm-room-send/report/compute-room-send-report.ts';
import type {
    RoomSendCellAnswer,
    RoomSendCellObservations,
    RoomSendCellSend
} from '../../../../../../apps/api-v1/scripts/perf/alm-room-send/room-send-cell-observations.ts';

const NO_OBSERVATIONS: RoomSendCellObservations = {
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

const NO_OFFERS_BY_ACCEPTANCE = {
    admitted: 0,
    duplicate: 0,
    'resync-required': 0,
    disposed: 0,
    'pending-admission': 0,
    'not-admitted': 0,
    control: 0,
    rejected: 0,
    threw: 0,
    unanswered: 0
};

const NO_REJECTIONS_BY_CODE = { malformed: 0, oversized: 0, unauthorized: 0, unsupported: 0 };

const CORRUPTION = 'Buffered inbound ordering slot lost its canonical message';

/** A send offered `seq` hundred milliseconds in, answered or thrown 10 ms later unless the answer says otherwise. */
function toSend(seq: number, answer: RoomSendCellAnswer): RoomSendCellSend {
    return {
        msgId: `send-${seq}`,
        publisherPeerId: 'publisher-1',
        seq,
        dueAtMs: seq * 100,
        sentAtMs: seq * 100,
        expectedRecipientPeerIds: ['recipient-1'],
        ...answer
    };
}

function threw(answeredAtMs: number, errorName: string, errorMessage: string): RoomSendCellAnswer {
    return { acceptance: 'threw', answeredAtMs, errorName, errorMessage };
}

describe('computeRoomSendReport: what the entry answered each kind of offer', () => {
    it('counts a send whose offer threw as thrown, by the name of its error, with the first message under each name', () => {
        const { sends } = computeRoomSendReport({
            ...NO_OBSERVATIONS,
            sends: [
                toSend(1, { acceptance: 'admitted', answeredAtMs: 110 }),
                toSend(2, threw(215, 'ALAdmissionCorruptionError', CORRUPTION)),
                toSend(3, threw(340, 'PostgresError', 'canceling statement due to statement timeout')),
                toSend(4, threw(450, 'ALAdmissionCorruptionError', 'Ordering head lost its track')),
                toSend(5, { acceptance: 'not-admitted', answeredAtMs: 520, notAdmittedReason: 'storage-unavailable' })
            ]
        });

        expect(sends).toMatchObject({
            attempted: 5,
            byAcceptance: { ...NO_OFFERS_BY_ACCEPTANCE, admitted: 1, threw: 3, 'not-admitted': 1 },
            rejectedByCode: NO_REJECTIONS_BY_CODE,
            notAdmittedByReason: { 'storage-unavailable': 1 },
            threwByErrorName: { ALAdmissionCorruptionError: 2, PostgresError: 1 },
            firstThrownMessageByErrorName: {
                ALAdmissionCorruptionError: CORRUPTION,
                PostgresError: 'canceling statement due to statement timeout'
            }
        });
    });

    it('measures the offer-to-answer delay over the sends the entry answered, and never over one whose offer threw', () => {
        const { sends } = computeRoomSendReport({
            ...NO_OBSERVATIONS,
            sends: [
                toSend(1, { acceptance: 'admitted', answeredAtMs: 110 }),
                toSend(2, threw(215, 'ALAdmissionCorruptionError', CORRUPTION)),
                toSend(3, { acceptance: 'admitted', answeredAtMs: 304 })
            ]
        });

        expect(sends.offerToAnswerMs).toMatchObject({ count: 2, p50: 4, max: 10 });
    });

    it('counts a later offer that threw or that the entry did not admit as a first offer is counted, under its cause', () => {
        const { resends } = computeRoomSendReport({
            ...NO_OBSERVATIONS,
            sends: [toSend(1, { acceptance: 'admitted', answeredAtMs: 110 })],
            resends: [
                { msgId: 'send-1', cause: 'first-hop', attempt: 1, sentAtMs: 2_100, ...threw(2_130, 'ALAdmissionCorruptionError', CORRUPTION) },
                { msgId: 'send-1', cause: 'first-hop', attempt: 2, sentAtMs: 4_100, acceptance: 'duplicate', answeredAtMs: 4_110 },
                {
                    msgId: 'send-1',
                    cause: 'repair',
                    attempt: 1,
                    sentAtMs: 4_200,
                    acceptance: 'not-admitted',
                    answeredAtMs: 4_210,
                    notAdmittedReason: 'storage-unavailable'
                },
                { msgId: 'send-1', cause: 'repair', attempt: 2, sentAtMs: 4_300, acceptance: 'rejected', answeredAtMs: 4_310, rejectionCode: 'unauthorized' }
            ]
        });

        expect(resends).toMatchObject({
            count: 4,
            byAcceptance: { ...NO_OFFERS_BY_ACCEPTANCE, duplicate: 1, threw: 1, 'not-admitted': 1, rejected: 1 },
            rejectedByCode: { ...NO_REJECTIONS_BY_CODE, unauthorized: 1 },
            notAdmittedByReason: { 'storage-unavailable': 1 },
            threwByErrorName: { ALAdmissionCorruptionError: 1 },
            firstThrownMessageByErrorName: { ALAdmissionCorruptionError: CORRUPTION }
        });
        expect(resends.byCause['first-hop']).toMatchObject({
            count: 2,
            byAcceptance: { ...NO_OFFERS_BY_ACCEPTANCE, duplicate: 1, threw: 1 },
            notAdmittedByReason: {},
            threwByErrorName: { ALAdmissionCorruptionError: 1 }
        });
        expect(resends.byCause.repair).toMatchObject({
            count: 2,
            byAcceptance: { ...NO_OFFERS_BY_ACCEPTANCE, 'not-admitted': 1, rejected: 1 },
            rejectedByCode: { ...NO_REJECTIONS_BY_CODE, unauthorized: 1 },
            notAdmittedByReason: { 'storage-unavailable': 1 },
            threwByErrorName: {}
        });
    });

    it('counts the recipients\' ACKs by what the entry answered each, and apart the ones that name no send', () => {
        const ack = { msgId: 'send-1', recipientPeerId: 'recipient-1' };
        const report = computeRoomSendReport({
            ...NO_OBSERVATIONS,
            sends: [toSend(1, { acceptance: 'admitted', answeredAtMs: 110 })],
            acks: [
                { ...ack, sentAtMs: 150, acceptance: 'control', answeredAtMs: 160 },
                { ...ack, sentAtMs: 151, acceptance: 'control', answeredAtMs: 161 },
                { ...ack, sentAtMs: 152, acceptance: 'control', answeredAtMs: 162 },
                { ...ack, sentAtMs: 153, acceptance: 'rejected', answeredAtMs: 163, rejectionCode: 'unauthorized' },
                { ...ack, sentAtMs: 154, acceptance: 'rejected', answeredAtMs: 164, rejectionCode: 'malformed' },
                { ...ack, sentAtMs: 155, ...threw(165, 'PostgresError', 'connection ended') },
                { ...ack, sentAtMs: 156, acceptance: 'unanswered', answeredAtMs: null },
                { ...ack, msgId: 'unknown', sentAtMs: 157, acceptance: 'control', answeredAtMs: 167 }
            ]
        });

        expect(report.acks).toEqual({
            offered: 7,
            byAcceptance: { ...NO_OFFERS_BY_ACCEPTANCE, control: 3, rejected: 2, threw: 1, unanswered: 1 },
            rejectedByCode: { ...NO_REJECTIONS_BY_CODE, unauthorized: 1, malformed: 1 },
            notAdmittedByReason: {},
            threwByErrorName: { PostgresError: 1 },
            firstThrownMessageByErrorName: { PostgresError: 'connection ended' }
        });
        expect(report.unmatched.acksOfUnknownMessage).toBe(1);
    });

    it('counts an error named like a property every object inherits under that name', () => {
        const { sends } = computeRoomSendReport({
            ...NO_OBSERVATIONS,
            sends: [toSend(1, threw(110, 'toString', 'first')), toSend(2, threw(210, 'toString', 'second'))]
        });

        expect(sends.threwByErrorName).toEqual({ toString: 2 });
        expect(sends.firstThrownMessageByErrorName).toEqual({ toString: 'first' });
    });
});
