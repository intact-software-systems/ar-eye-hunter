import { describe, expect, it } from 'vitest';

import type { OrderedSendCellOffer } from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/ordered-send-cell-observations.ts';
import { OrderedSendOfferLedger } from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/ordered-send-offer-ledger.ts';

function toOffer(seq: number, sentAtMs: number): OrderedSendCellOffer {
    return {
        msgId: `session-01-a-send-${seq}`,
        publisherPeerId: 'session-01-a',
        seq,
        dueAtMs: sentAtMs - 0.5,
        sentAtMs,
        expectedRecipientPeerIds: ['session-02-b']
    };
}

const NO_TERMINAL_RECEIPT = (): boolean => false;

describe('OrderedSendOfferLedger', () => {
    it('joins each offer with the answer the entry gave it, in the order the sends were offered', () => {
        const ledger = new OrderedSendOfferLedger();
        ledger.recordOffer(toOffer(1, 100));
        ledger.recordOffer(toOffer(2, 600));
        ledger.recordAnswer('session-01-a-send-2', { acceptance: 'admitted', answeredAtMs: 640.25 });
        ledger.recordAnswer('session-01-a-send-1', {
            acceptance: 'rejected',
            answeredAtMs: 650,
            rejectionCode: 'unauthorized'
        });

        expect(ledger.close()).toEqual([
            { ...toOffer(1, 100), acceptance: 'rejected', answeredAtMs: 650, rejectionCode: 'unauthorized' },
            { ...toOffer(2, 600), acceptance: 'admitted', answeredAtMs: 640.25 }
        ]);
    });

    it('closes a send the entry has not answered as unanswered, and keeps it so when its answer comes later', () => {
        const ledger = new OrderedSendOfferLedger();
        ledger.recordOffer(toOffer(1, 100));

        const sends = ledger.close();
        ledger.recordAnswer('session-01-a-send-1', { acceptance: 'admitted', answeredAtMs: 90_000 });

        expect(sends).toEqual([{ ...toOffer(1, 100), acceptance: 'unanswered', answeredAtMs: null }]);
        expect(ledger.close()).toEqual(sends);
    });

    it('is settled once every send is answered and every send the entry accepted has its terminal receipt', () => {
        const ledger = new OrderedSendOfferLedger();
        ledger.recordOffer(toOffer(1, 100));
        ledger.recordOffer(toOffer(2, 600));
        ledger.recordOffer(toOffer(3, 1_100));
        const settledAfterNoAnswer = ledger.isSettled(() => true);
        ledger.recordAnswer('session-01-a-send-1', { acceptance: 'admitted', answeredAtMs: 130 });
        ledger.recordAnswer('session-01-a-send-2', { acceptance: 'pending-admission', answeredAtMs: 640 });
        ledger.recordAnswer('session-01-a-send-3', {
            acceptance: 'not-admitted',
            answeredAtMs: 1_140,
            notAdmittedReason: 'storage-unavailable'
        });

        expect(settledAfterNoAnswer).toBe(false);
        expect(ledger.isSettled(NO_TERMINAL_RECEIPT)).toBe(false);
        expect(ledger.isSettled((msgId) => msgId === 'session-01-a-send-1')).toBe(false);
        expect(ledger.isSettled((msgId) => msgId !== 'session-01-a-send-3')).toBe(true);
    });

    it('is settled with no send offered, and reads no last offer then', () => {
        const ledger = new OrderedSendOfferLedger();

        expect(ledger.isSettled(NO_TERMINAL_RECEIPT)).toBe(true);
        expect(ledger.getLastOfferAtMs()).toBeUndefined();
    });

    it('reads the instant of the offer made last', () => {
        const ledger = new OrderedSendOfferLedger();
        ledger.recordOffer(toOffer(1, 100.125));
        ledger.recordOffer(toOffer(2, 600.75));

        expect(ledger.getLastOfferAtMs()).toBe(600.75);
    });

    it('keeps every failure an offer threw, in the order they were thrown', () => {
        const ledger = new OrderedSendOfferLedger();
        const first = new Error('connection ended');
        const second = new Error('statement failed');
        ledger.recordFailure(first);
        ledger.recordFailure(second);

        expect(ledger.getFailures()).toEqual([first, second]);
    });
});
