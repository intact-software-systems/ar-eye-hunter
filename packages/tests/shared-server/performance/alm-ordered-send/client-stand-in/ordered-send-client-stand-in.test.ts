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

/** A stand-in whose publisher has offered the sends 1 to `count` of its track, every one at 1,000 ms. */
function createStandInAfterOffers(count: number): OrderedSendClientStandIn {
    const standIn = new OrderedSendClientStandIn(SERVER);
    for (let seq = 1; seq <= count; seq += 1) {
        standIn.recordFirstOffer({
            send: toSend(seq),
            message: toOrderedSendMessage({ send: toSend(seq), roomRef: ROOM, createdAtEpochMs: 1_800_000_000_000 }),
            frame: toFrame(seq),
            offeredAtMs: 1_000
        });
    }
    return standIn;
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

    it('spends four repairs on a send, as the product\'s client plans, and answers no fifth request for it', () => {
        const standIn = createStandInAfterOffers(2);

        const attempts = [1, 2, 3, 4, 5].map((gapRequestNumber) =>
            standIn.acceptSocketRead(PUBLISHER, toGapNackRead(2, [{ from: 1, to: 1 }], gapRequestNumber))
                .reoffers.map(({ attempt }) => attempt)
        );

        expect(attempts).toEqual([[1], [2], [3], [4], []]);
    });

    it('serves a wide gap 32 sends at a time, and the rest when its follow-up is served', () => {
        const standIn = createStandInAfterOffers(40);

        const firstPage = standIn.acceptSocketRead(PUBLISHER, toGapNackRead(40, [{ from: 1, to: 39 }], 1));
        const secondPage = standIn.serveRepairFollowUp(firstPage.followUp!);

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
});
