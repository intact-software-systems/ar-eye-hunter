import { describe, expect, it } from 'vitest';

import { AL_RECEIPT_DEADLINE_GRACE_MS, decodeALControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALReceiptRecordOpening } from '@shared/alm/receipt-record/al-receipt-record-rows.ts';
import {
    isWsQueueBoxServerReceiptEncodable,
    isWsQueueBoxServerResendRecoveredReceipt,
    toWsQueueBoxServerEndedReceiptControlId,
    toWsQueueBoxServerReceiptControlMessage,
    toWsQueueBoxServerReceiptPayload
} from '@shared/services/ws-queue-box-server/receipt/to-ws-queue-box-server-receipt-control.ts';

const SERVER = 'server';
const NOW = 1_800_000_000_000;

/** An opening for `count` recipients whose ids are each 128 characters long. */
function opening(count: number): ALReceiptRecordOpening {
    return {
        originPeerId: SERVER,
        msgId: 'delta-1',
        traceId: 'trace-receipt-control',
        expectedRecipientPeerIds: Array.from({ length: count }, (_, index) => `${String(index).padStart(3, '0')}${'r'.repeat(125)}`),
        neverSentRecipientPeerIds: [],
        snapshotVersion: 0,
        deadlineAtMs: NOW + 7_000
    };
}

describe('the receipt control', () => {
    it('carries the largest receipt of 249 recipients of 128 characters, and not of 250', () => {
        // Pins a head opened for an audience whose terminal receipt no control can encode, so its ended work threw
        // on every delivery; and the rule refusing an audience whose largest receipt still encodes.
        expect([isWsQueueBoxServerReceiptEncodable(opening(249), SERVER), isWsQueueBoxServerReceiptEncodable(opening(250), SERVER)])
            .toEqual([true, false]);
    });

    it('is a receipt control from the server that outlives the later of its deadline and its observation', () => {
        // Pins a receipt row expiring with its message's deadline, before a late terminal receipt reaches the origin.
        const head = opening(2);
        const receipt = toWsQueueBoxServerReceiptPayload(head, {
            confirmedRecipientPeerIds: head.expectedRecipientPeerIds.slice(0, 1),
            outsideAudienceRecipientPeerIds: [],
            phase: 'timed-out',
            observedAtEpochMs: NOW + 9_000
        });
        const control = toWsQueueBoxServerReceiptControlMessage(
            { receipt, opening: head, controlId: toWsQueueBoxServerEndedReceiptControlId(head), settlesServerRow: true },
            SERVER
        );

        expect(control.id).toMatchObject({
            msgId: toWsQueueBoxServerEndedReceiptControlId(head),
            senderId: SERVER,
            ts: NOW + 9_000,
            traceId: 'trace-receipt-control'
        });
        expect(control.constraints?.expiresAtMs).toBe(NOW + 9_000 + AL_RECEIPT_DEADLINE_GRACE_MS);
        expect(decodeALControlMessage(control).right).toEqual({ type: 'receipt', payload: receipt });
    });
});

describe('which receipt a sender\'s resend recovers', () => {
    const head = opening(2);
    const receiptAt = (phase: 'admitted' | 'complete' | 'timed-out', expected: readonly string[]) => ({
        ...toWsQueueBoxServerReceiptPayload(head, {
            confirmedRecipientPeerIds: [],
            outsideAudienceRecipientPeerIds: [],
            phase,
            observedAtEpochMs: NOW
        }),
        expectedRecipientPeerIds: expected
    });

    // Pins an `admitted` with a head behind it kept waiting for the outbound worker as a row.
    it('is an admitted receipt that expects somebody', () => {
        expect(isWsQueueBoxServerResendRecoveredReceipt(receiptAt('admitted', head.expectedRecipientPeerIds))).toBe(true);
    });

    // Pins the only answer of a send admitted to nobody, which no resend is answered again, losing its row.
    it('is not an admitted receipt that expects nobody', () => {
        expect(isWsQueueBoxServerResendRecoveredReceipt(receiptAt('admitted', []))).toBe(false);
    });

    // Pins a terminal receipt losing its durable row.
    it('is not a complete or a timed-out receipt', () => {
        expect([
            isWsQueueBoxServerResendRecoveredReceipt(receiptAt('complete', head.expectedRecipientPeerIds)),
            isWsQueueBoxServerResendRecoveredReceipt(receiptAt('timed-out', head.expectedRecipientPeerIds))
        ]).toEqual([false, false]);
    });
});
