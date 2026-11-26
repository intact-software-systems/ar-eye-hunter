import { describe, expect, it } from 'vitest';

import type { ALNackReason, ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
import type { ALSeqRange } from '@shared/al-contracts/al-runtime.ts';

import { OrderedSendClientStandIn } from '../../../../../../apps/api-v1/scripts/perf/alm-ordered-send/client-stand-in/ordered-send-client-stand-in.ts';
import type { OrderedSendScheduledSend } from '../../../../../../apps/api-v1/scripts/perf/alm-ordered-send/compute-ordered-send-schedule.ts';
import { toOrderedSendMessage } from '../../../../../../apps/api-v1/scripts/perf/alm-ordered-send/to-ordered-send-message.ts';
import type { OrderedSendSocketRead } from '../../../../../../apps/api-v1/scripts/perf/alm-ordered-send/to-ordered-send-socket-read.ts';

const SERVER = 'default-qbox-server';
const PUBLISHER = 'session-01-a';
const ROOM = { applicationId: 'ordered-send-cell', workspaceId: 'default', groupId: 'room-run-1' };
/** The track the product keys the publisher's room sends on: the room's ordering key, the sender and epoch 0. */
const TRACK = '["ordered-send-cell","default","room-run-1"]:session-01-a:0';

function toSend(seq: number): OrderedSendScheduledSend {
    return {
        msgId: `${PUBLISHER}-send-${seq}`,
        publisherPeerId: PUBLISHER,
        publisherInstanceIndex: 0,
        seq,
        dueOffsetMs: 0,
        expectedRecipientPeerIds: ['session-02-b']
    };
}

function toFrame(seq: number): string {
    return `{"frame-of-send":${seq}}`;
}

function offerSend(standIn: OrderedSendClientStandIn, seq: number, offeredAtMs: number): void {
    standIn.recordFirstOffer({
        send: toSend(seq),
        message: toOrderedSendMessage({ send: toSend(seq), roomRef: ROOM, createdAtEpochMs: 1_800_000_000_000 }),
        frame: toFrame(seq),
        offeredAtMs
    });
}

/**
 * A stand-in whose publisher has offered the sends 1 to `count` of its track, every one at 1,000 ms. A send lives the
 * 30 s of the `notification` channel, so each is alive until 31,000 ms.
 */
function createStandInAfterOffers(count: number): OrderedSendClientStandIn {
    const standIn = new OrderedSendClientStandIn(SERVER);
    for (let seq = 1; seq <= count; seq += 1) {
        offerSend(standIn, seq, 1_000);
    }
    return standIn;
}

/** The same frame, read at another instant than 1,200 ms. */
function readAt(read: OrderedSendSocketRead, atMs: number): OrderedSendSocketRead {
    switch (read.kind) {
        case 'receipt':
            return { ...read, receipt: { ...read.receipt, atMs } };
        case 'control':
            return { ...read, control: { ...read.control, atMs } };
        case 'arrival':
        case 'unclassified-control':
            return read;
    }
}

function toReceiptRead(seq: number, phase: ALReceiptPayload['phase']): OrderedSendSocketRead {
    return { kind: 'receipt', receipt: { msgId: `${PUBLISHER}-send-${seq}`, phase, atMs: 1_200 } };
}

function toNackRead(seq: number, reason: ALNackReason, gap: object): OrderedSendSocketRead {
    const msgId = `${PUBLISHER}-send-${seq}`;
    return {
        kind: 'control',
        control: { type: 'nack', msgId, reason, atMs: 1_200 },
        request: {
            type: 'nack',
            payload: {
                msgId,
                fromPeerId: SERVER,
                toPeerId: PUBLISHER,
                logicalRecipientPeerId: SERVER,
                originPeerId: PUBLISHER,
                reason,
                observedAtEpochMs: 1_800_000_000_200,
                proof: null,
                ...gap
            }
        }
    };
}

/** The server's gap NACK about send `seq`, whose arrival showed that `missingRanges` of its track are missing. */
function toGapNackRead(seq: number, missingRanges: readonly ALSeqRange[], gapRequestNumber: number): OrderedSendSocketRead {
    return toNackRead(seq, 'gap', {
        orderingKey: TRACK,
        expectedSeq: missingRanges[0].from,
        missingRanges,
        gapRequestNumber,
        relayHopsLeft: 0
    });
}

/** The repair request the server sends beside a gap NACK, about the same gap. */
function toRepairRequestRead(seq: number, missingRanges: readonly ALSeqRange[]): OrderedSendSocketRead {
    const msgId = `${PUBLISHER}-send-${seq}`;
    return {
        kind: 'control',
        control: { type: 'repair', msgId, reason: 'missing-seq', atMs: 1_200 },
        request: {
            type: 'repair',
            payload: {
                msgId,
                fromPeerId: SERVER,
                toPeerId: PUBLISHER,
                reason: 'missing-seq',
                observedAtEpochMs: 1_800_000_000_200,
                orderingKey: TRACK,
                expectedSeq: missingRanges[0].from,
                missingRanges,
                gapRequestNumber: 1
            }
        }
    };
}

describe('OrderedSendClientStandIn', () => {
    it('resends a send its server has not answered for 2 s after the offer, three times 2 s apart, the frame unchanged', () => {
        const standIn = createStandInAfterOffers(1);
        const resend = (attempt: number) => ({ send: toSend(1), frame: toFrame(1), cause: 'first-hop', attempt });

        expect(standIn.takeFirstHopResendsDue(2_999)).toEqual([]);
        expect(standIn.takeFirstHopResendsDue(3_000)).toEqual([resend(1)]);
        expect(standIn.takeFirstHopResendsDue(4_999)).toEqual([]);
        expect(standIn.takeFirstHopResendsDue(5_000)).toEqual([resend(2)]);
        expect(standIn.takeFirstHopResendsDue(7_000)).toEqual([resend(3)]);
        expect(standIn.takeFirstHopResendsDue(9_000)).toEqual([]);
        expect(standIn.takeFirstHopResendsDue(31_000)).toEqual([]);
    });

    it('waits no longer for a send once its publisher read a receipt of it, in whichever phase', () => {
        const standIn = createStandInAfterOffers(4);

        standIn.acceptSocketRead(PUBLISHER, toReceiptRead(1, 'admitted'));
        standIn.acceptSocketRead(PUBLISHER, toReceiptRead(2, 'complete'));
        standIn.acceptSocketRead(PUBLISHER, toReceiptRead(3, 'timed-out'));

        expect(standIn.takeFirstHopResendsDue(3_000).map(({ send }) => send.msgId)).toEqual(['session-01-a-send-4']);
    });

    it('waits no longer for a send a NACK ended, and still waits for one a gap NACK names', () => {
        const standIn = createStandInAfterOffers(3);

        standIn.acceptSocketRead(PUBLISHER, toNackRead(1, 'expired', {}));
        standIn.acceptSocketRead(PUBLISHER, toGapNackRead(3, [{ from: 2, to: 2 }], 1));

        expect(standIn.takeFirstHopResendsDue(3_000).map(({ send }) => send.msgId))
            .toEqual(['session-01-a-send-2', 'session-01-a-send-3']);
    });

    it('answers a gap with the missing sends, once for its NACK and its repair request, and again for its renewal', () => {
        const standIn = createStandInAfterOffers(6);
        const missing = [{ from: 3, to: 4 }];

        const nackAnswer = standIn.acceptSocketRead(PUBLISHER, toGapNackRead(6, missing, 1));
        const repairRequestAnswer = standIn.acceptSocketRead(PUBLISHER, toRepairRequestRead(6, missing));
        const renewalAnswer = standIn.acceptSocketRead(PUBLISHER, toGapNackRead(6, [{ from: 4, to: 4 }], 2));

        expect(nackAnswer).toEqual({
            reoffers: [
                { send: toSend(3), frame: toFrame(3), cause: 'repair', attempt: 1 },
                { send: toSend(4), frame: toFrame(4), cause: 'repair', attempt: 1 }
            ],
            followUp: undefined
        });
        expect(repairRequestAnswer).toEqual({ reoffers: [], followUp: undefined });
        expect(renewalAnswer.reoffers).toEqual([{ send: toSend(4), frame: toFrame(4), cause: 'repair', attempt: 2 }]);
    });

    it('spends four repairs on a send, as the product\'s client plans, and ends the send when a fifth request finds them spent', () => {
        const standIn = createStandInAfterOffers(2);

        const attempts = [1, 2, 3, 4, 5, 6].map((gapRequestNumber) =>
            standIn.acceptSocketRead(
                PUBLISHER,
                readAt(toGapNackRead(2, [{ from: 1, to: 1 }], gapRequestNumber), 1_000 + gapRequestNumber * 100)
            ).reoffers.map(({ attempt }) => attempt)
        );

        expect(attempts).toEqual([[1], [2], [3], [4], [], []]);
        expect(standIn.getSendEnds()).toEqual([
            { msgId: 'session-01-a-send-1', cause: 'repair-budget-spent', atMs: 1_500 }
        ]);
        expect(standIn.getDeclinedRepairs()).toEqual([
            { msgId: 'session-01-a-send-1', reason: 'send-ended', atMs: 1_600 }
        ]);
    });

    it('serves a wide gap 32 sends at a time, and the rest when its follow-up is served', () => {
        const standIn = createStandInAfterOffers(40);

        const firstPage = standIn.acceptSocketRead(PUBLISHER, toGapNackRead(40, [{ from: 1, to: 39 }], 1));
        const secondPage = standIn.serveRepairFollowUp(firstPage.followUp!, 1_201);

        expect(firstPage.reoffers.map(({ send }) => send.seq)).toEqual(Array.from({ length: 32 }, (_, index) => index + 1));
        expect(secondPage.reoffers.map(({ send }) => send.seq)).toEqual([33, 34, 35, 36, 37, 38, 39]);
        expect(secondPage.followUp).toBeUndefined();
    });

    it('answers no request a session read about a send that is not its own', () => {
        const standIn = createStandInAfterOffers(3);

        expect(standIn.acceptSocketRead('session-02-b', toGapNackRead(3, [{ from: 2, to: 2 }], 1)))
            .toEqual({ reoffers: [], followUp: undefined });
        expect(standIn.acceptSocketRead('session-02-b', toReceiptRead(1, 'admitted')))
            .toEqual({ reoffers: [], followUp: undefined });
        expect(standIn.takeFirstHopResendsDue(3_000)).toHaveLength(3);
    });

    it('ends a send whose three first-hop resends drew no answer, 8 s after its offer, and offers it again by no path', () => {
        const standIn = createStandInAfterOffers(2);
        [3_000, 5_000, 7_000].forEach((nowMs) => standIn.takeFirstHopResendsDue(nowMs));

        expect(standIn.getSendEnds()).toEqual([]);
        expect(standIn.takeFirstHopResendsDue(9_000)).toEqual([]);
        expect(standIn.getSendEnds()).toEqual([
            { msgId: 'session-01-a-send-1', cause: 'first-hop-exhausted', atMs: 9_000 },
            { msgId: 'session-01-a-send-2', cause: 'first-hop-exhausted', atMs: 9_000 }
        ]);

        // The gap NACK names send 2, which has ended too: it still raises its hint, and the send it asks for is declined.
        const gapAnswer = standIn.acceptSocketRead(PUBLISHER, readAt(toGapNackRead(2, [{ from: 1, to: 1 }], 1), 9_500));
        expect(gapAnswer).toEqual({ reoffers: [], followUp: undefined });
        expect(standIn.takeFirstHopResendsDue(11_000)).toEqual([]);
        expect(standIn.getDeclinedRepairs()).toEqual([
            { msgId: 'session-01-a-send-1', reason: 'send-ended', atMs: 9_500 }
        ]);
        expect(standIn.getSendEnds()).toHaveLength(2);
    });

    it('ends a send on a complete or a timed-out receipt its publisher read, and not on an admitted one', () => {
        const standIn = createStandInAfterOffers(4);

        standIn.acceptSocketRead(PUBLISHER, toReceiptRead(1, 'admitted'));
        standIn.acceptSocketRead(PUBLISHER, readAt(toReceiptRead(2, 'complete'), 1_300.5));
        standIn.acceptSocketRead(PUBLISHER, readAt(toReceiptRead(3, 'timed-out'), 1_400));
        standIn.acceptSocketRead(PUBLISHER, readAt(toReceiptRead(2, 'complete'), 1_450));
        standIn.acceptSocketRead('session-02-b', readAt(toReceiptRead(4, 'complete'), 1_460));

        expect(standIn.getSendEnds()).toEqual([
            { msgId: 'session-01-a-send-2', cause: 'terminal-receipt', atMs: 1_300.5 },
            { msgId: 'session-01-a-send-3', cause: 'terminal-receipt', atMs: 1_400 }
        ]);
    });

    it('re-offers nothing for a repair of a send it has ended, and re-offers the live sends the same request asks for', () => {
        const standIn = createStandInAfterOffers(4);
        standIn.acceptSocketRead(PUBLISHER, toReceiptRead(1, 'admitted'));
        standIn.acceptSocketRead(PUBLISHER, toReceiptRead(2, 'complete'));

        const answer = standIn.acceptSocketRead(PUBLISHER, readAt(toGapNackRead(4, [{ from: 1, to: 3 }], 1), 1_500));

        expect(answer.reoffers.map(({ send, cause, attempt }) => [send.seq, cause, attempt]))
            .toEqual([[1, 'repair', 1], [3, 'repair', 1]]);
        expect(standIn.getDeclinedRepairs()).toEqual([
            { msgId: 'session-01-a-send-2', reason: 'send-ended', atMs: 1_500 }
        ]);
    });

    it('ends a send on a NACK that refuses it for good, ends only its wait on not-yet-in-sync, and neither on a gap', () => {
        const standIn = createStandInAfterOffers(4);

        standIn.acceptSocketRead(PUBLISHER, readAt(toNackRead(1, 'expired', {}), 1_250));
        standIn.acceptSocketRead(PUBLISHER, readAt(toNackRead(2, 'not-yet-in-sync', {}), 1_260));
        standIn.acceptSocketRead(PUBLISHER, readAt(toNackRead(3, 'resync-required', {}), 1_270));
        const gapAnswer = standIn.acceptSocketRead(PUBLISHER, readAt(toGapNackRead(4, [{ from: 1, to: 3 }], 1), 1_280));

        expect(standIn.getSendEnds()).toEqual([
            { msgId: 'session-01-a-send-1', cause: 'terminal-nack', atMs: 1_250 },
            { msgId: 'session-01-a-send-3', cause: 'terminal-nack', atMs: 1_270 }
        ]);
        expect(gapAnswer.reoffers.map(({ send }) => send.seq)).toEqual([2]);
        expect(standIn.takeFirstHopResendsDue(3_000).map(({ send }) => send.seq)).toEqual([4]);
    });

    it('ends as expired, at the first instant given at or past its lifetime, each send nothing ended before', () => {
        const standIn = createStandInAfterOffers(3);
        standIn.acceptSocketRead(PUBLISHER, toReceiptRead(1, 'admitted'));
        standIn.acceptSocketRead(PUBLISHER, toReceiptRead(2, 'complete'));
        standIn.acceptSocketRead(PUBLISHER, toReceiptRead(3, 'admitted'));

        standIn.endExpiredSends(30_999.5);
        expect(standIn.getSendEnds()).toEqual([{ msgId: 'session-01-a-send-2', cause: 'terminal-receipt', atMs: 1_200 }]);

        standIn.endExpiredSends(31_000);
        standIn.endExpiredSends(31_010);
        expect(standIn.getSendEnds()).toEqual([
            { msgId: 'session-01-a-send-2', cause: 'terminal-receipt', atMs: 1_200 },
            { msgId: 'session-01-a-send-1', cause: 'expired', atMs: 31_000 },
            { msgId: 'session-01-a-send-3', cause: 'expired', atMs: 31_000 }
        ]);
    });

    it('raises no hint for a request that names an expired send, though the sends it asks for still live', () => {
        const standIn = new OrderedSendClientStandIn(SERVER);
        offerSend(standIn, 3, 1_000);
        offerSend(standIn, 1, 5_000);
        offerSend(standIn, 2, 5_000);
        [1, 2, 3].forEach((seq) => standIn.acceptSocketRead(PUBLISHER, readAt(toReceiptRead(seq, 'admitted'), 5_100)));

        const whileItLives = standIn.acceptSocketRead(PUBLISHER, readAt(toGapNackRead(3, [{ from: 2, to: 2 }], 1), 30_999));
        const onceExpired = standIn.acceptSocketRead(PUBLISHER, readAt(toGapNackRead(3, [{ from: 1, to: 2 }], 2), 31_000));

        expect(whileItLives.reoffers.map(({ send }) => send.seq)).toEqual([2]);
        expect(onceExpired).toEqual({ reoffers: [], followUp: undefined });
        expect(standIn.getDeclinedRepairs()).toEqual([
            { msgId: 'session-01-a-send-3', reason: 'named-send-expired', atMs: 31_000 }
        ]);
    });

    it('declines a send that expired between two executions of one request, at the instant of the later one', () => {
        const standIn = new OrderedSendClientStandIn(SERVER);
        for (let seq = 1; seq <= 40; seq += 1) {
            offerSend(standIn, seq, seq <= 39 ? 1_000 : 2_000);
        }

        const firstPage = standIn.acceptSocketRead(PUBLISHER, readAt(toGapNackRead(40, [{ from: 1, to: 39 }], 1), 30_990));
        const secondPage = standIn.serveRepairFollowUp(firstPage.followUp!, 31_000);

        expect(firstPage.reoffers).toHaveLength(32);
        expect(secondPage.reoffers).toEqual([]);
        expect(standIn.getDeclinedRepairs()).toEqual(
            [33, 34, 35, 36, 37, 38, 39].map((seq) => ({
                msgId: `session-01-a-send-${seq}`,
                reason: 'send-expired',
                atMs: 31_000
            }))
        );
    });

    it('still offers, at the instant it leaves, a repair of a send nothing has ended since it was decided', () => {
        const standIn = createStandInAfterOffers(3);
        const decided = standIn.acceptSocketRead(PUBLISHER, toGapNackRead(3, [{ from: 1, to: 2 }], 1));
        standIn.acceptSocketRead(PUBLISHER, readAt(toReceiptRead(1, 'admitted'), 1_200.5));

        const offered = decided.reoffers.filter((reoffer) => standIn.confirmRepairReoffer(reoffer, 1_201));

        expect(offered).toEqual([
            { send: toSend(1), frame: toFrame(1), cause: 'repair', attempt: 1 },
            { send: toSend(2), frame: toFrame(2), cause: 'repair', attempt: 1 }
        ]);
        expect(standIn.getDeclinedRepairs()).toEqual([]);
    });

    it('offers no repair of a send whose terminal receipt its publisher read after the repair was decided, and records it declined', () => {
        const standIn = createStandInAfterOffers(2);
        const decided = standIn.acceptSocketRead(PUBLISHER, toGapNackRead(2, [{ from: 1, to: 1 }], 1));
        standIn.acceptSocketRead(PUBLISHER, readAt(toReceiptRead(1, 'complete'), 1_200.5));

        const offered = decided.reoffers.filter((reoffer) => standIn.confirmRepairReoffer(reoffer, 1_201));

        expect(decided.reoffers.map(({ send }) => send.seq)).toEqual([1]);
        expect(offered).toEqual([]);
        expect(standIn.getDeclinedRepairs()).toEqual([
            { msgId: 'session-01-a-send-1', reason: 'send-ended', atMs: 1_201 }
        ]);
    });

    it('offers no repair of a send whose first-hop retries ran out after the repair was decided, and records it declined', () => {
        const standIn = createStandInAfterOffers(2);
        [3_000, 5_000, 7_000].forEach((nowMs) => standIn.takeFirstHopResendsDue(nowMs));
        const decided = standIn.acceptSocketRead(PUBLISHER, readAt(toGapNackRead(2, [{ from: 1, to: 1 }], 1), 8_999.5));
        standIn.takeFirstHopResendsDue(9_000);

        const offered = decided.reoffers.filter((reoffer) => standIn.confirmRepairReoffer(reoffer, 9_000.5));

        expect(decided.reoffers.map(({ send }) => send.seq)).toEqual([1]);
        expect(offered).toEqual([]);
        expect(standIn.getDeclinedRepairs()).toEqual([
            { msgId: 'session-01-a-send-1', reason: 'send-ended', atMs: 9_000.5 }
        ]);
    });

    it('offers no repair of a send whose lifetime ended after the repair was decided, before a poll has ended it and after', () => {
        const standIn = createStandInAfterOffers(3);
        [1, 2, 3].forEach((seq) => standIn.acceptSocketRead(PUBLISHER, toReceiptRead(seq, 'admitted')));
        const decided = standIn.acceptSocketRead(PUBLISHER, readAt(toGapNackRead(3, [{ from: 1, to: 2 }], 1), 30_999.5));
        const [repairOfFirst, repairOfSecond] = decided.reoffers;

        const firstOffered = standIn.confirmRepairReoffer(repairOfFirst, 31_000);
        standIn.endExpiredSends(31_000);
        const secondOffered = standIn.confirmRepairReoffer(repairOfSecond, 31_000.5);

        expect(decided.reoffers.map(({ send }) => send.seq)).toEqual([1, 2]);
        expect([firstOffered, secondOffered]).toEqual([false, false]);
        expect(standIn.getDeclinedRepairs()).toEqual([
            { msgId: 'session-01-a-send-1', reason: 'send-expired', atMs: 31_000 },
            { msgId: 'session-01-a-send-2', reason: 'send-expired', atMs: 31_000.5 }
        ]);
    });

    it('offers no repair of a send its publisher never offered, and records nothing of it', () => {
        const standIn = createStandInAfterOffers(1);

        const offered = standIn.confirmRepairReoffer({ send: toSend(2), frame: toFrame(2), cause: 'repair', attempt: 1 }, 1_201);

        expect(offered).toBe(false);
        expect(standIn.getDeclinedRepairs()).toEqual([]);
    });
});
