import { describe, expect, it } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    newALAckControlMessage,
    newALNackControlMessage,
    newALReceiptControlMessage,
    newALRepairControlMessage
} from '@shared/al-contracts/al-control.ts';

import { toRoomSendMessage } from '../../../../../apps/api-v1/scripts/perf/alm-room-send/to-room-send-message.ts';
import { toRoomSendSocketRead } from '../../../../../apps/api-v1/scripts/perf/alm-room-send/to-room-send-socket-read.ts';

const SERVER = 'default-qbox-server';
const PUBLISHER = 'session-01-a';
const SEND_MSG_ID = 'session-01-a-send-3';
const OBSERVED_AT_EPOCH_MS = 1_800_000_000_100;

/** The envelope identity of a control the server sends: an id of its own, never the id of the send it is about. */
const CONTROL_ID: ALMessage['id'] = {
    v: 4,
    msgId: 'control-of-the-server-1',
    senderId: SERVER,
    ts: OBSERVED_AT_EPOCH_MS,
    traceId: 'trace-1'
};

const GAP = { orderingKey: 'room-track', expectedSeq: 2, missingRanges: [{ from: 2, to: 2 }], gapRequestNumber: 1 };

const GAP_NACK = newALNackControlMessage(CONTROL_ID, {
    msgId: SEND_MSG_ID,
    fromPeerId: SERVER,
    toPeerId: PUBLISHER,
    logicalRecipientPeerId: SERVER,
    originPeerId: PUBLISHER,
    reason: 'gap',
    observedAtEpochMs: OBSERVED_AT_EPOCH_MS,
    ...GAP,
    relayHopsLeft: 0,
    proof: null
});

function toRead(message: ALMessage) {
    return toRoomSendSocketRead({ message, readerPeerId: PUBLISHER, atMs: 41.625 });
}

describe('toRoomSendSocketRead', () => {
    it('reads a message that is no control as an arrival of it at the session that read it', () => {
        const copy = toRoomSendMessage({
            send: {
                msgId: SEND_MSG_ID,
                publisherPeerId: PUBLISHER,
                seq: 3,
                publisherInstanceIndex: 0,
                dueOffsetMs: 0,
                expectedRecipientPeerIds: ['session-02-b']
            },
            roomRef: { applicationId: 'room-send-cell', workspaceId: 'default', groupId: 'room-run-1' },
            createdAtEpochMs: 1_800_000_000_000,
            ordering: 'ordering-key'
        });

        expect(toRoomSendSocketRead({ message: copy, readerPeerId: 'session-02-b', atMs: 41.625 })).toEqual({
            kind: 'arrival',
            arrival: { msgId: SEND_MSG_ID, recipientPeerId: 'session-02-b', atMs: 41.625 }
        });
    });

    it('reads a receipt control as a receipt of the send it names, in its phase', () => {
        const receipt = newALReceiptControlMessage(CONTROL_ID, {
            msgId: SEND_MSG_ID,
            originPeerId: PUBLISHER,
            expectedRecipientPeerIds: ['session-02-b'],
            confirmedRecipientPeerIds: [],
            outsideAudienceRecipientPeerIds: [],
            snapshotVersion: 1,
            phase: 'timed-out',
            observedAtEpochMs: OBSERVED_AT_EPOCH_MS
        });

        expect(toRead(receipt)).toEqual({
            kind: 'receipt',
            receipt: { msgId: SEND_MSG_ID, phase: 'timed-out', atMs: 41.625 }
        });
    });

    it('reads a NACK as a control of the message it names, never of its own envelope, with all it asks', () => {
        expect(toRead(GAP_NACK)).toEqual({
            kind: 'control',
            control: { type: 'nack', msgId: SEND_MSG_ID, reason: 'gap', atMs: 41.625 },
            request: {
                type: 'nack',
                payload: {
                    msgId: SEND_MSG_ID,
                    fromPeerId: SERVER,
                    toPeerId: PUBLISHER,
                    logicalRecipientPeerId: SERVER,
                    originPeerId: PUBLISHER,
                    reason: 'gap',
                    observedAtEpochMs: OBSERVED_AT_EPOCH_MS,
                    orderingKey: 'room-track',
                    expectedSeq: 2,
                    missingRanges: [{ from: 2, to: 2 }],
                    gapRequestNumber: 1,
                    relayHopsLeft: 0,
                    proof: null
                }
            }
        });
    });

    it('reads a repair request as a control of the message it names, with all it asks', () => {
        const repair = newALRepairControlMessage(CONTROL_ID, {
            msgId: SEND_MSG_ID,
            fromPeerId: SERVER,
            toPeerId: PUBLISHER,
            reason: 'missing-seq',
            observedAtEpochMs: OBSERVED_AT_EPOCH_MS,
            ...GAP
        });

        expect(toRead(repair)).toEqual({
            kind: 'control',
            control: { type: 'repair', msgId: SEND_MSG_ID, reason: 'missing-seq', atMs: 41.625 },
            request: {
                type: 'repair',
                payload: {
                    msgId: SEND_MSG_ID,
                    fromPeerId: SERVER,
                    toPeerId: PUBLISHER,
                    reason: 'missing-seq',
                    observedAtEpochMs: OBSERVED_AT_EPOCH_MS,
                    orderingKey: 'room-track',
                    expectedSeq: 2,
                    missingRanges: [{ from: 2, to: 2 }],
                    gapRequestNumber: 1
                }
            }
        });
    });

    it('leaves an ACK unclassified, under its payload type: the cell has no list for one', () => {
        const ack = newALAckControlMessage(CONTROL_ID, {
            ackedMsgId: SEND_MSG_ID,
            fromPeerId: SERVER,
            toPeerId: PUBLISHER,
            originPeerId: PUBLISHER,
            logicalRecipientPeerId: 'session-02-b',
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: OBSERVED_AT_EPOCH_MS,
            proof: null
        });

        expect(toRead(ack)).toEqual({
            kind: 'unclassified-control',
            unclassifiedControl: { typeId: 'al.control.ack.v3', atMs: 41.625 }
        });
    });

    it('leaves a control whose payload does not decode unclassified, under its payload type', () => {
        const undecodable: ALMessage = { ...GAP_NACK, payload: { ...GAP_NACK.payload, resource: '{"reason":"gap"}' } };

        expect(toRead(undecodable)).toEqual({
            kind: 'unclassified-control',
            unclassifiedControl: { typeId: 'al.control.nack.v5', atMs: 41.625 }
        });
    });
});
