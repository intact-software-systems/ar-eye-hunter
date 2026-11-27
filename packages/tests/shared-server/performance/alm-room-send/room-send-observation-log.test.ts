import { describe, expect, it } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    newALAckControlMessage,
    newALNackControlMessage,
    newALReceiptControlMessage,
    newALRepairControlMessage,
    type ALReceiptPayload
} from '@shared/al-contracts/al-control.ts';

import { RoomSendObservationLog } from '../../../../../apps/api-v1/scripts/perf/alm-room-send/room-send-observation-log.ts';
import { toRoomSendMessage } from '../../../../../apps/api-v1/scripts/perf/alm-room-send/to-room-send-message.ts';

const ROOM = { applicationId: 'room-send-cell', workspaceId: 'default', groupId: 'room-run-1' };
const PUBLISHER = 'session-01-a';
const SERVER = 'default-qbox-server';

/** The envelope identity of a control the server sends about a send. */
const CONTROL_ID: ALMessage['id'] = {
    v: 4,
    msgId: 'control-of-the-server-1',
    senderId: SERVER,
    ts: 1_800_000_000_100,
    traceId: 'trace-1'
};

interface TestClock {
    nowMs: number;
}

function toCopyFrame(seq: number): string {
    return JSON.stringify(toRoomSendMessage({
        send: {
            msgId: `${PUBLISHER}-send-${seq}`,
            publisherPeerId: PUBLISHER,
            seq,
            publisherInstanceIndex: 0,
            dueOffsetMs: 0,
            expectedRecipientPeerIds: ['session-02-b', 'session-03-c']
        },
        roomRef: ROOM,
        createdAtEpochMs: 1_800_000_000_000,
        ordering: 'ordering-key'
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

function toNackFrame(seq: number): string {
    return JSON.stringify(newALNackControlMessage(CONTROL_ID, {
        msgId: `${PUBLISHER}-send-${seq}`,
        fromPeerId: SERVER,
        toPeerId: PUBLISHER,
        logicalRecipientPeerId: SERVER,
        originPeerId: PUBLISHER,
        reason: 'expired',
        observedAtEpochMs: 1_800_000_000_100,
        proof: null
    }));
}

function toRepairFrame(seq: number): string {
    return JSON.stringify(newALRepairControlMessage(CONTROL_ID, {
        msgId: `${PUBLISHER}-send-${seq}`,
        fromPeerId: SERVER,
        toPeerId: PUBLISHER,
        reason: 'retransmit',
        observedAtEpochMs: 1_800_000_000_100
    }));
}

function toAckFrame(seq: number): string {
    return JSON.stringify(newALAckControlMessage(CONTROL_ID, {
        ackedMsgId: `${PUBLISHER}-send-${seq}`,
        fromPeerId: SERVER,
        toPeerId: PUBLISHER,
        originPeerId: PUBLISHER,
        logicalRecipientPeerId: 'session-02-b',
        carrier: 'ws',
        status: 'delivered',
        observedAtEpochMs: 1_800_000_000_100,
        proof: null
    }));
}

describe('RoomSendObservationLog', () => {
    it('records every read of a copy as an arrival, and owes one ACK for a session\'s first read of it only', () => {
        const clock: TestClock = { nowMs: 10.5 };
        const log = new RoomSendObservationLog(() => clock.nowMs);

        const firstRead = log.recordSocketFrame('session-02-b', toCopyFrame(1));
        clock.nowMs = 11.25;
        const repeatedRead = log.recordSocketFrame('session-02-b', toCopyFrame(1));
        clock.nowMs = 12;
        const otherSessionRead = log.recordSocketFrame('session-03-c', toCopyFrame(1));

        expect(firstRead?.ackOwedCopy?.id.msgId).toBe('session-01-a-send-1');
        expect(repeatedRead?.ackOwedCopy).toBeUndefined();
        expect(repeatedRead?.read).toEqual({
            kind: 'arrival',
            arrival: { msgId: 'session-01-a-send-1', recipientPeerId: 'session-02-b', atMs: 11.25, namesOrderingKey: true }
        });
        expect(otherSessionRead?.ackOwedCopy?.id.msgId).toBe('session-01-a-send-1');
        expect(log.endObservation().arrivals).toEqual([
            { msgId: 'session-01-a-send-1', recipientPeerId: 'session-02-b', atMs: 10.5, namesOrderingKey: true },
            { msgId: 'session-01-a-send-1', recipientPeerId: 'session-02-b', atMs: 11.25, namesOrderingKey: true },
            { msgId: 'session-01-a-send-1', recipientPeerId: 'session-03-c', atMs: 12, namesOrderingKey: true }
        ]);
    });

    it('records a copy its own publisher read, and owes no ACK for it', () => {
        const log = new RoomSendObservationLog(() => 5);

        expect(log.recordSocketFrame(PUBLISHER, toCopyFrame(2))?.ackOwedCopy).toBeUndefined();
        expect(log.endObservation().arrivals)
            .toEqual([{ msgId: 'session-01-a-send-2', recipientPeerId: 'session-01-a', atMs: 5, namesOrderingKey: true }]);
    });

    it('records a receipt frame as a receipt of its phase, never as an arrival, and owes no ACK for it', () => {
        const clock: TestClock = { nowMs: 20 };
        const log = new RoomSendObservationLog(() => clock.nowMs);

        const admitted = log.recordSocketFrame(PUBLISHER, toReceiptFrame(1, 'admitted'));
        clock.nowMs = 95.75;
        const complete = log.recordSocketFrame(PUBLISHER, toReceiptFrame(1, 'complete'));

        expect([admitted?.ackOwedCopy, complete?.ackOwedCopy]).toEqual([undefined, undefined]);
        expect(complete?.read).toEqual({
            kind: 'receipt',
            receipt: { msgId: 'session-01-a-send-1', phase: 'complete', atMs: 95.75 }
        });
        expect(log.endObservation()).toEqual({
            arrivals: [],
            handOffs: [],
            receipts: [
                { msgId: 'session-01-a-send-1', phase: 'admitted', atMs: 20 },
                { msgId: 'session-01-a-send-1', phase: 'complete', atMs: 95.75 }
            ],
            controls: [],
            unclassifiedControls: [],
            observationEndedAtMs: 95.75
        });
    });

    it('records a NACK and a repair request as controls and any other control apart, each as read, and owes no ACK', () => {
        const clock: TestClock = { nowMs: 70.125 };
        const log = new RoomSendObservationLog(() => clock.nowMs);

        const nack = log.recordSocketFrame(PUBLISHER, toNackFrame(2));
        clock.nowMs = 70.5;
        const ack = log.recordSocketFrame(PUBLISHER, toAckFrame(1));
        clock.nowMs = 71;
        const repair = log.recordSocketFrame(PUBLISHER, toRepairFrame(1));

        expect([nack?.ackOwedCopy, ack?.ackOwedCopy, repair?.ackOwedCopy]).toEqual([undefined, undefined, undefined]);
        expect([nack?.read.kind, ack?.read.kind, repair?.read.kind])
            .toEqual(['control', 'unclassified-control', 'control']);
        expect(log.endObservation()).toEqual({
            arrivals: [],
            handOffs: [],
            receipts: [],
            controls: [
                { type: 'nack', msgId: 'session-01-a-send-2', reason: 'expired', atMs: 70.125 },
                { type: 'repair', msgId: 'session-01-a-send-1', reason: 'retransmit', atMs: 71 }
            ],
            unclassifiedControls: [{ typeId: 'al.control.ack.v3', atMs: 70.5 }],
            observationEndedAtMs: 71
        });
    });

    it('records a hand-off with the instance that made it, in the order the hand-offs happened', () => {
        const clock: TestClock = { nowMs: 30 };
        const log = new RoomSendObservationLog(() => clock.nowMs);

        log.recordHandOff('session-01-a-send-1', 2);
        clock.nowMs = 31.5;
        log.recordHandOff('session-01-a-send-2', 0);

        expect(log.endObservation().handOffs).toEqual([
            { msgId: 'session-01-a-send-1', instanceIndex: 2, atMs: 30 },
            { msgId: 'session-01-a-send-2', instanceIndex: 0, atMs: 31.5 }
        ]);
    });

    it('records nothing that happens after observation ended, and returns no read of it', () => {
        const clock: TestClock = { nowMs: 40 };
        const log = new RoomSendObservationLog(() => clock.nowMs);
        log.recordSocketFrame('session-02-b', toCopyFrame(1));
        clock.nowMs = 50;
        const observingBeforeItsEnd = log.isObserving();
        const ended = log.endObservation();
        clock.nowMs = 60;

        const lateCopy = log.recordSocketFrame('session-03-c', toCopyFrame(1));
        const lateReceipt = log.recordSocketFrame(PUBLISHER, toReceiptFrame(1, 'complete'));
        const lateNack = log.recordSocketFrame(PUBLISHER, toNackFrame(1));
        log.recordSocketFrame(PUBLISHER, toAckFrame(1));
        log.recordHandOff('session-01-a-send-1', 1);

        expect([observingBeforeItsEnd, log.isObserving()]).toEqual([true, false]);
        expect([lateCopy, lateReceipt, lateNack]).toEqual([undefined, undefined, undefined]);
        const recordedWhileObserving = {
            arrivals: [{ msgId: 'session-01-a-send-1', recipientPeerId: 'session-02-b', atMs: 40, namesOrderingKey: true }],
            handOffs: [],
            receipts: [],
            controls: [],
            unclassifiedControls: []
        };
        expect(ended).toEqual({ ...recordedWhileObserving, observationEndedAtMs: 50 });
        expect(log.endObservation()).toMatchObject(recordedWhileObserving);
    });

    it('refuses a frame that is no AL envelope: the server writes nothing else to a session\'s socket', () => {
        const log = new RoomSendObservationLog(() => 1);

        expect(() => log.recordSocketFrame('session-02-b', '{"pong":true}')).toThrow();
    });
});
