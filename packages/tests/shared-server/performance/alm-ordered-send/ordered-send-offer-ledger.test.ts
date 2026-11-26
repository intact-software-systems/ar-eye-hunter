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

        expect(ledger.close()).toEqual({
            sends: [
                { ...toOffer(1, 100), acceptance: 'rejected', answeredAtMs: 650, rejectionCode: 'unauthorized' },
                { ...toOffer(2, 600), acceptance: 'admitted', answeredAtMs: 640.25 }
            ],
            resends: [],
            acks: []
        });
    });

    it('keeps every later offer of a send apart from its first, each with the answer the entry gave that offer', () => {
        const ledger = new OrderedSendOfferLedger();
        ledger.recordOffer(toOffer(1, 100));
        ledger.recordAnswer('session-01-a-send-1', { acceptance: 'pending-admission', answeredAtMs: 140 });
        const repair = ledger.recordResend({
            msgId: 'session-01-a-send-1',
            cause: 'repair',
            attempt: 1,
            sentAtMs: 700.5
        });
        const firstHop = ledger.recordResend({
            msgId: 'session-01-a-send-1',
            cause: 'first-hop',
            attempt: 1,
            sentAtMs: 2_100
        });
        const unanswered = ledger.recordResend({
            msgId: 'session-01-a-send-1',
            cause: 'first-hop',
            attempt: 2,
            sentAtMs: 4_100
        });
        ledger.recordResendAnswer(firstHop, { acceptance: 'duplicate', answeredAtMs: 2_130 });
        ledger.recordResendAnswer(repair, { acceptance: 'admitted', answeredAtMs: 2_140 });

        const closed = ledger.close();
        ledger.recordResendAnswer(unanswered, { acceptance: 'duplicate', answeredAtMs: 90_000 });

        expect(closed).toEqual({
            sends: [{ ...toOffer(1, 100), acceptance: 'pending-admission', answeredAtMs: 140 }],
            resends: [
                {
                    msgId: 'session-01-a-send-1',
                    cause: 'repair',
                    attempt: 1,
                    sentAtMs: 700.5,
                    acceptance: 'admitted',
                    answeredAtMs: 2_140
                },
                {
                    msgId: 'session-01-a-send-1',
                    cause: 'first-hop',
                    attempt: 1,
                    sentAtMs: 2_100,
                    acceptance: 'duplicate',
                    answeredAtMs: 2_130
                },
                {
                    msgId: 'session-01-a-send-1',
                    cause: 'first-hop',
                    attempt: 2,
                    sentAtMs: 4_100,
                    acceptance: 'unanswered',
                    answeredAtMs: null
                }
            ],
            acks: []
        });
        expect(ledger.close()).toEqual(closed);
        expect(ledger.getLastOfferAtMs()).toBe(100);
    });

    it('closes a send the entry has not answered as unanswered, and keeps it so when its answer comes later', () => {
        const ledger = new OrderedSendOfferLedger();
        ledger.recordOffer(toOffer(1, 100));

        const closed = ledger.close();
        ledger.recordAnswer('session-01-a-send-1', { acceptance: 'admitted', answeredAtMs: 90_000 });

        expect(closed.sends).toEqual([{ ...toOffer(1, 100), acceptance: 'unanswered', answeredAtMs: null }]);
        expect(ledger.close()).toEqual(closed);
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

    it('keeps an offer that threw as the answer of that offer, of a send and of a later offer alike', () => {
        const ledger = new OrderedSendOfferLedger();
        const threw = {
            acceptance: 'threw',
            answeredAtMs: 130.5,
            errorName: 'ALAdmissionCorruptionError',
            errorMessage: 'Buffered inbound ordering slot lost its canonical message'
        } as const;
        ledger.recordOffer(toOffer(1, 100));
        ledger.recordOffer(toOffer(2, 600));
        ledger.recordAnswer('session-01-a-send-1', threw);
        ledger.recordAnswer('session-01-a-send-2', { acceptance: 'admitted', answeredAtMs: 640 });
        const resend = ledger.recordResend({ msgId: 'session-01-a-send-1', cause: 'first-hop', attempt: 1, sentAtMs: 2_100 });
        ledger.recordResendAnswer(resend, { ...threw, answeredAtMs: 2_140 });

        const closed = ledger.close();

        expect(closed.sends).toEqual([
            { ...toOffer(1, 100), ...threw },
            { ...toOffer(2, 600), acceptance: 'admitted', answeredAtMs: 640 }
        ]);
        expect(closed.resends).toEqual([
            { msgId: 'session-01-a-send-1', cause: 'first-hop', attempt: 1, sentAtMs: 2_100, ...threw, answeredAtMs: 2_140 }
        ]);
    });

    it('keeps every ACK a recipient offered with the answer the entry gave it, in the order offered', () => {
        const ledger = new OrderedSendOfferLedger();
        const relayed = ledger.recordAck({ msgId: 'session-01-a-send-1', recipientPeerId: 'session-02-b', sentAtMs: 150 });
        const counted = ledger.recordAck({ msgId: 'session-01-a-send-1', recipientPeerId: 'session-04-a', sentAtMs: 160 });
        const unanswered = ledger.recordAck({ msgId: 'session-01-a-send-1', recipientPeerId: 'session-03-c', sentAtMs: 170 });
        ledger.recordAckAnswer(counted, { acceptance: 'control', answeredAtMs: 165, handled: true });
        ledger.recordAckAnswer(relayed, { acceptance: 'control', answeredAtMs: 180, handled: false });

        const closed = ledger.close();
        ledger.recordAckAnswer(unanswered, { acceptance: 'control', answeredAtMs: 90_000, handled: true });

        expect(closed.acks).toEqual([
            {
                msgId: 'session-01-a-send-1',
                recipientPeerId: 'session-02-b',
                sentAtMs: 150,
                acceptance: 'control',
                answeredAtMs: 180,
                handled: false
            },
            {
                msgId: 'session-01-a-send-1',
                recipientPeerId: 'session-04-a',
                sentAtMs: 160,
                acceptance: 'control',
                answeredAtMs: 165,
                handled: true
            },
            {
                msgId: 'session-01-a-send-1',
                recipientPeerId: 'session-03-c',
                sentAtMs: 170,
                acceptance: 'unanswered',
                answeredAtMs: null
            }
        ]);
        expect(ledger.close()).toEqual(closed);
    });
});
