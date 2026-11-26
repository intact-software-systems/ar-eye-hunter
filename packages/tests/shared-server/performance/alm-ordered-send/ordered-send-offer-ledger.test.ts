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

    it('reads no last offer while no send was offered', () => {
        expect(new OrderedSendOfferLedger().getLastOfferAtMs()).toBeUndefined();
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
