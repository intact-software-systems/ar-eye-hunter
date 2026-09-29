import {
    createInitialALDeliveryLifecycle,
    type ALDeliveryCarrier,
    type ALDeliveryLifecycle,
    type ALDeliverySettlement
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { computeALDeliveryLifecycle } from '@shared/alm/delivery/compute-al-delivery-lifecycle.ts';
import {
    describe,
    expect,
    it
} from 'vitest';

const MSG_ID = 'msg-1';
const EXHAUSTED_DETAIL = 'The receipt ran out of retries after 3 of 3.';

function reduce(settlements: readonly ALDeliverySettlement[]): ALDeliveryLifecycle {
    const opened = createInitialALDeliveryLifecycle({
        msgId: MSG_ID,
        typeId: 'room.command.v1',
        ackMode: 'receiver',
        receiptAlgo: 'receiver',
        expiresAtMs: 30_000,
        submittedAtMs: 1_000
    });
    return settlements.reduce(computeALDeliveryLifecycle, opened);
}

function toAdmission(carrier: ALDeliveryCarrier): ALDeliverySettlement {
    return {
        kind: 'admission',
        msgId: MSG_ID,
        carrier,
        atMs: 2_000,
        verdict: { kind: 'admitted', durable: false, queuedAttempts: 1 },
        trackedReceiptAlgo: 'receiver'
    };
}

function toReceipt(
    carrier: ALDeliveryCarrier,
    confirmed: readonly string[],
    complete: boolean
): ALDeliverySettlement {
    return {
        kind: 'acknowledgement',
        msgId: MSG_ID,
        carrier,
        atMs: 4_000,
        mode: 'receiver',
        confirmedHopPeerIds: [],
        unconfirmedHopPeerIds: [],
        expectedRecipientPeerIds: ['b', 'c'],
        confirmedRecipientPeerIds: confirmed,
        unconfirmedRecipientPeerIds: ['b', 'c'].filter((peerId) => !confirmed.includes(peerId)),
        complete
    };
}

function toExhausted(carrier: ALDeliveryCarrier): ALDeliverySettlement {
    return {
        kind: 'receipt-exhausted',
        msgId: MSG_ID,
        carrier,
        atMs: 4_500,
        mode: 'receiver',
        confirmedPeerIds: [],
        unconfirmedPeerIds: ['b', 'c'],
        cause: 'budget',
        detail: EXHAUSTED_DETAIL
    };
}

const HAND_OVER: ALDeliverySettlement = {
    kind: 'carrier-fallback',
    msgId: MSG_ID,
    carrier: 'rtc',
    atMs: 3_000,
    to: 'ws',
    reason: 'receipt-exhausted',
    detail: EXHAUSTED_DETAIL
};

describe('a hand-over to the fallback carrier (D56, Q3)', () => {
    it('starts with no hand-over', () => {
        expect(reduce([]).evidence.carrierFallback).toBeUndefined();
    });

    it('records the hand-over as evidence and leaves the state to the carrier that took the message', () => {
        const handedOver = reduce([toAdmission('rtc'), HAND_OVER]);

        expect(handedOver.state).toBe('queued');
        expect(handedOver.evidence.carrierFallback).toEqual({
            from: 'rtc',
            to: 'ws',
            reason: 'receipt-exhausted',
            atMs: 3_000,
            detail: EXHAUSTED_DETAIL
        });
    });

    it('lets no receipt fact of the carrier the handle left move it, even after the WS receipt', () => {
        const acknowledged = reduce([
            toAdmission('rtc'),
            HAND_OVER,
            toAdmission('ws'),
            toReceipt('ws', ['b', 'c'], true)
        ]);
        expect(acknowledged.state).toBe('acknowledged');

        const late = [
            toReceipt('rtc', [], false),
            toExhausted('rtc'),
            {
                kind: 'relay-rejected',
                msgId: MSG_ID,
                carrier: 'rtc',
                atMs: 5_000,
                relayRejection: { relay: 'peer', peerId: 'relay-1', reason: 'resync-required' },
                detail: 'Hop relay-1 refused the message: resync-required.'
            } satisfies ALDeliverySettlement
        ].reduce(computeALDeliveryLifecycle, acknowledged);

        expect(late.evidence).toEqual(acknowledged.evidence);
        expect(late.lateSettlementCount).toBe(acknowledged.lateSettlementCount);
    });

    it('ends the handle failed when the WS receipt runs out after the hand-over', () => {
        const exhausted = reduce([toAdmission('rtc'), HAND_OVER, toAdmission('ws'), toExhausted('ws')]);

        expect(exhausted.state).toBe('failed');
        expect(exhausted.evidence.carrierFallback).toMatchObject({ from: 'rtc', to: 'ws' });
    });

    it('keeps the RTC receipt facts of a handle that never handed over', () => {
        expect(reduce([toAdmission('rtc'), toExhausted('rtc')]).state).toBe('failed');
    });

    it('still records the attempt rows of the carrier the handle left', () => {
        const next = reduce([toAdmission('rtc'), HAND_OVER, {
            kind: 'attempt-settled',
            msgId: MSG_ID,
            carrier: 'rtc',
            atMs: 3_100,
            attemptId: 'send-a',
            outcome: 'cancelled',
            submissionAttempted: false,
            detail: 'The message was cancelled before its carrier ran.',
            willRetry: false
        }]);

        expect(next.evidence.attempts).toMatchObject([{ carrier: 'rtc', outcome: 'cancelled' }]);
    });
});
