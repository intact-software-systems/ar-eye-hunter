import { describe, expect, it } from 'vitest';

import { toWsQueueBoxServerLiveReceiptTransport } from '@shared/services/ws-queue-box-server/receipt/to-ws-queue-box-server-live-receipt-transport.ts';
import type { WsQueueBoxServerIssuedReceipt } from '@shared/services/ws-queue-box-server/receipt/to-ws-queue-box-server-receipt-control.ts';

const ISSUED: WsQueueBoxServerIssuedReceipt = {
    receipt: {
        msgId: 'subject',
        originPeerId: 'origin',
        expectedRecipientPeerIds: ['b', 'c'],
        confirmedRecipientPeerIds: ['b'],
        outsideAudienceRecipientPeerIds: [],
        snapshotVersion: 7,
        phase: 'admitted',
        observedAtEpochMs: 1_000
    },
    opening: {
        msgId: 'subject',
        originPeerId: 'origin',
        traceId: 'trace-subject',
        expectedRecipientPeerIds: ['b', 'c'],
        neverSentRecipientPeerIds: [],
        snapshotVersion: 7,
        deadlineAtMs: 31_000
    },
    controlId: 'receipt-control-1',
    settlesServerRow: false
};

describe('the observation of a live receipt on one connection', () => {
    // Pins a live receipt observed as anything but a direct write to an origin connected here.
    it('states a returned write as a sent recipient transport to an origin that is here', () => {
        expect(toWsQueueBoxServerLiveReceiptTransport(ISSUED, { connectionId: 'origin', nativeCall: 'returned', written: true }, 'server')).toEqual({
            kind: 'receipt-transport',
            serverPeerId: 'server',
            receiptControlMsgId: 'receipt-control-1',
            traceId: 'trace-subject',
            receipt: ISSUED.receipt,
            transport: 'recipient',
            nativeCall: 'returned',
            connectionId: 'origin',
            publisherCall: 'absent',
            originIsHere: true,
            outcome: 'sent',
            submissionAttempted: true,
            retryAfterMs: undefined
        });
    });

    // Pins a write that threw read as sent, or as a submission the native socket was never asked for.
    it('states a write that threw as failed, with the native call the socket reached', () => {
        expect(toWsQueueBoxServerLiveReceiptTransport(ISSUED, { connectionId: 'origin', nativeCall: 'invoked', written: false }, 'server'))
            .toMatchObject({ nativeCall: 'invoked', outcome: 'failed', submissionAttempted: true });
        expect(toWsQueueBoxServerLiveReceiptTransport(ISSUED, { connectionId: 'origin', nativeCall: 'not-called', written: false }, 'server'))
            .toMatchObject({ nativeCall: 'not-called', outcome: 'failed', submissionAttempted: false });
    });

    // Pins an observation a sink could change the issued receipt through.
    it('carries copies of the receipt\'s sets, not the issued receipt\'s own arrays', () => {
        const { receipt } = toWsQueueBoxServerLiveReceiptTransport(ISSUED, { connectionId: 'origin', nativeCall: 'returned', written: true }, 'server');

        expect(Object.isFrozen(receipt)).toBe(true);
        for (const set of ['expectedRecipientPeerIds', 'confirmedRecipientPeerIds', 'outsideAudienceRecipientPeerIds'] as const) {
            expect(receipt[set], set).toEqual(ISSUED.receipt[set]);
            expect(receipt[set], set).not.toBe(ISSUED.receipt[set]);
            expect(Object.isFrozen(receipt[set]), set).toBe(true);
        }
    });
});
