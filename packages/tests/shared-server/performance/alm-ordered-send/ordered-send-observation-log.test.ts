import { describe, expect, it } from 'vitest';

import { newALReceiptControlMessage, type ALReceiptPayload } from '@shared/al-contracts/al-control.ts';

import { OrderedSendObservationLog } from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/ordered-send-observation-log.ts';
import { toOrderedSendMessage } from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/to-ordered-send-message.ts';

const ROOM = { applicationId: 'ordered-send-cell', workspaceId: 'default', groupId: 'room-run-1' };
const PUBLISHER = 'session-01-a';

interface TestClock {
    nowMs: number;
}

function toCopyFrame(seq: number): string {
    return JSON.stringify(toOrderedSendMessage({
        send: {
            msgId: `${PUBLISHER}-send-${seq}`,
            publisherPeerId: PUBLISHER,
            seq,
            dueOffsetMs: 0,
            expectedRecipientPeerIds: ['session-02-b', 'session-03-c']
        },
        roomRef: ROOM,
        createdAtEpochMs: 1_800_000_000_000
    }));
}

function toReceiptFrame(seq: number, phase: ALReceiptPayload['phase']): string {
    return JSON.stringify(newALReceiptControlMessage(
        { v: 4, msgId: `receipt-${seq}-${phase}`, senderId: 'default-qbox-server', ts: 1_800_000_000_100, traceId: 'trace-1' },
        {
            msgId: `${PUBLISHER}-send-${seq}`,
            originPeerId: PUBLISHER,
            expectedRecipientPeerIds: ['session-02-b', 'session-03-c'],
            confirmedRecipientPeerIds: phase === 'complete' ? ['session-02-b', 'session-03-c'] : [],
            outsideAudienceRecipientPeerIds: [],
            snapshotVersion: 1,
            phase,
            observedAtEpochMs: 1_800_000_000_100
        }
    ));
}

describe('OrderedSendObservationLog', () => {
    it('records every read of a copy as an arrival, and owes one ACK for a session\'s first read of it only', () => {
        const clock: TestClock = { nowMs: 10.5 };
        const log = new OrderedSendObservationLog(() => clock.nowMs);

        const firstRead = log.recordSocketFrame('session-02-b', toCopyFrame(1));
        clock.nowMs = 11.25;
        const repeatedRead = log.recordSocketFrame('session-02-b', toCopyFrame(1));
        clock.nowMs = 12;
        const otherSessionRead = log.recordSocketFrame('session-03-c', toCopyFrame(1));

        expect(firstRead?.id.msgId).toBe('session-01-a-send-1');
        expect(repeatedRead).toBeUndefined();
        expect(otherSessionRead?.id.msgId).toBe('session-01-a-send-1');
        expect(log.endObservation().arrivals).toEqual([
            { msgId: 'session-01-a-send-1', recipientPeerId: 'session-02-b', atMs: 10.5 },
            { msgId: 'session-01-a-send-1', recipientPeerId: 'session-02-b', atMs: 11.25 },
            { msgId: 'session-01-a-send-1', recipientPeerId: 'session-03-c', atMs: 12 }
        ]);
    });

    it('records a copy its own publisher read, and owes no ACK for it', () => {
        const log = new OrderedSendObservationLog(() => 5);

        expect(log.recordSocketFrame(PUBLISHER, toCopyFrame(2))).toBeUndefined();
        expect(log.endObservation().arrivals)
            .toEqual([{ msgId: 'session-01-a-send-2', recipientPeerId: 'session-01-a', atMs: 5 }]);
    });

    it('records a receipt frame as a receipt of its phase, never as an arrival, and owes no ACK for it', () => {
        const clock: TestClock = { nowMs: 20 };
        const log = new OrderedSendObservationLog(() => clock.nowMs);

        const admitted = log.recordSocketFrame(PUBLISHER, toReceiptFrame(1, 'admitted'));
        clock.nowMs = 95.75;
        const complete = log.recordSocketFrame(PUBLISHER, toReceiptFrame(1, 'complete'));

        expect([admitted, complete]).toEqual([undefined, undefined]);
        expect(log.endObservation()).toEqual({
            arrivals: [],
            handOffs: [],
            receipts: [
                { msgId: 'session-01-a-send-1', phase: 'admitted', atMs: 20 },
                { msgId: 'session-01-a-send-1', phase: 'complete', atMs: 95.75 }
            ],
            observationEndedAtMs: 95.75
        });
    });

    it('holds a send terminal once a complete or a timed-out receipt of it was read, and not on its admitted one', () => {
        const log = new OrderedSendObservationLog(() => 1);

        log.recordSocketFrame(PUBLISHER, toReceiptFrame(1, 'admitted'));
        log.recordSocketFrame(PUBLISHER, toReceiptFrame(2, 'complete'));
        log.recordSocketFrame(PUBLISHER, toReceiptFrame(3, 'timed-out'));

        expect(['session-01-a-send-1', 'session-01-a-send-2', 'session-01-a-send-3', 'session-01-a-send-4']
            .map((msgId) => log.hasTerminalReceipt(msgId)))
            .toEqual([false, true, true, false]);
    });

    it('records a hand-off with the instance that made it, in the order the hand-offs happened', () => {
        const clock: TestClock = { nowMs: 30 };
        const log = new OrderedSendObservationLog(() => clock.nowMs);

        log.recordHandOff('session-01-a-send-1', 2);
        clock.nowMs = 31.5;
        log.recordHandOff('session-01-a-send-2', 0);

        expect(log.endObservation().handOffs).toEqual([
            { msgId: 'session-01-a-send-1', instanceIndex: 2, atMs: 30 },
            { msgId: 'session-01-a-send-2', instanceIndex: 0, atMs: 31.5 }
        ]);
    });

    it('records nothing that happens after observation ended, and owes no ACK for it', () => {
        const clock: TestClock = { nowMs: 40 };
        const log = new OrderedSendObservationLog(() => clock.nowMs);
        log.recordSocketFrame('session-02-b', toCopyFrame(1));
        clock.nowMs = 50;
        const observingBeforeItsEnd = log.isObserving();
        const ended = log.endObservation();
        clock.nowMs = 60;

        const lateCopy = log.recordSocketFrame('session-03-c', toCopyFrame(1));
        log.recordSocketFrame(PUBLISHER, toReceiptFrame(1, 'complete'));
        log.recordHandOff('session-01-a-send-1', 1);

        expect([observingBeforeItsEnd, log.isObserving()]).toEqual([true, false]);
        expect(lateCopy).toBeUndefined();
        expect(ended).toEqual({
            arrivals: [{ msgId: 'session-01-a-send-1', recipientPeerId: 'session-02-b', atMs: 40 }],
            handOffs: [],
            receipts: [],
            observationEndedAtMs: 50
        });
        expect(log.hasTerminalReceipt('session-01-a-send-1')).toBe(false);
    });

    it('refuses a frame that is no AL envelope: the server writes nothing else to a session\'s socket', () => {
        const log = new OrderedSendObservationLog(() => 1);

        expect(() => log.recordSocketFrame('session-02-b', '{"pong":true}')).toThrow();
    });
});
