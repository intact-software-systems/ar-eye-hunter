import { describe, expect, it } from 'vitest';

import type { ALOutboundRepairRequest } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALReceiptRecordOpening } from '@shared/alm/receipt-record/al-receipt-record-rows.ts';
import type { ALReceiptRecord } from '@shared/alm/receipt-record/al-receipt-record.ts';
import { toWsQueueBoxServerUnconfirmedRepairRequest } from '@shared/services/ws-queue-box-server/receipt/to-ws-queue-box-server-unconfirmed-repair-request.ts';

const NOW_MS = 1_800_000_000_000;
const REQUEST: ALOutboundRepairRequest = {
    trigger: 'ack-timeout',
    repair: { enabled: true, algo: 'retransmit', maxAttempts: 3 },
    failedPeerIds: ['a', 'b', 'c'],
    completedHopPeerIds: [],
    missingRanges: []
};
const OPENING: ALReceiptRecordOpening = {
    msgId: 'room-message-1',
    originPeerId: 'o',
    traceId: 'trace-unconfirmed-repair-request',
    expectedRecipientPeerIds: ['a', 'b', 'c'],
    neverSentRecipientPeerIds: [],
    snapshotVersion: 7,
    deadlineAtMs: NOW_MS + 1
};

/** An open head expecting a, b and c: a confirmed, b outside the audience, c still unconfirmed. */
function openView(deadlineAtMs: number): ALReceiptRecord.View {
    return {
        head: { phase: 'open', opening: { ...OPENING, deadlineAtMs } },
        tally: { confirmedRecipientPeerIds: ['a'], outsideAudienceRecipientPeerIds: ['b'], complete: false }
    };
}

describe('a retry narrowed to what the receipt record has not confirmed', () => {
    it('leaves out the confirmed and the outside recipients of an open head', () => {
        // Pins the resend of a receipt retry to a recipient the record already confirmed or placed outside.
        const narrowed = toWsQueueBoxServerUnconfirmedRepairRequest(REQUEST, openView(NOW_MS + 1), NOW_MS);
        expect(narrowed).toEqual({ ...REQUEST, failedPeerIds: ['c'] });
    });

    it('asks for nothing once the head has ended', () => {
        // Pins a retry whose row has not yet taken the terminal receipt resending a receipt that is over.
        const ended: ALReceiptRecord.View = {
            head: {
                phase: 'timed-out',
                opening: OPENING,
                confirmedRecipientPeerIds: ['a'],
                outsideAudienceRecipientPeerIds: [],
                endedAtEpochMs: NOW_MS
            },
            tally: { confirmedRecipientPeerIds: ['a'], outsideAudienceRecipientPeerIds: [], complete: false }
        };
        expect(toWsQueueBoxServerUnconfirmedRepairRequest(REQUEST, ended, NOW_MS)).toBeUndefined();
    });

    it('asks for nothing once the head\'s deadline has passed', () => {
        // Pins a retry resending at the deadline instant, where the record already refuses every confirmation.
        expect(toWsQueueBoxServerUnconfirmedRepairRequest(REQUEST, openView(NOW_MS), NOW_MS)).toBeUndefined();
    });

    it('leaves a request that is not a receipt retry as it came', () => {
        // Pins a NACK's repair, which names the recipient that asked, being narrowed by a receipt it does not serve.
        const nack: ALOutboundRepairRequest = { ...REQUEST, trigger: 'nack' };
        expect(toWsQueueBoxServerUnconfirmedRepairRequest(nack, openView(NOW_MS + 1), NOW_MS)).toBe(nack);
    });

    it('leaves a request with no record as it came', () => {
        // Pins a message that opened no receipt losing its retry.
        expect(toWsQueueBoxServerUnconfirmedRepairRequest(REQUEST, undefined, NOW_MS)).toBe(REQUEST);
    });
});
