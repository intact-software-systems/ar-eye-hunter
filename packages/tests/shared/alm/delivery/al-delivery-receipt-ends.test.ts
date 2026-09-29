import type { ALReceiptMode } from '@shared/al-contracts/al-policy.ts';
import {
    createInitialALDeliveryLifecycle,
    isALDeliveryTerminal,
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
const AT_MS = 2_000;
const EXHAUSTED_DETAIL = 'The receipt ran out of retries after 3 of 3.';

function createAdmittedLifecycle(): ALDeliveryLifecycle {
    const opened = createInitialALDeliveryLifecycle({
        msgId: MSG_ID,
        typeId: 'room.command.v1',
        ackMode: 'receiver',
        receiptAlgo: 'receiver',
        expiresAtMs: 30_000,
        submittedAtMs: 1_000
    });
    return computeALDeliveryLifecycle(opened, {
        kind: 'admission',
        msgId: MSG_ID,
        carrier: 'rtc',
        atMs: AT_MS,
        verdict: { kind: 'admitted', durable: false, queuedAttempts: 1 },
        trackedReceiptAlgo: 'receiver'
    });
}

function toReceiptExhausted(
    mode: ALReceiptMode,
    confirmedPeerIds: readonly string[],
    unconfirmedPeerIds: readonly string[]
): Extract<ALDeliverySettlement, Readonly<{ kind: 'receipt-exhausted'; }>> {
    return {
        kind: 'receipt-exhausted',
        msgId: MSG_ID,
        carrier: 'rtc',
        atMs: AT_MS,
        mode,
        confirmedPeerIds,
        unconfirmedPeerIds,
        cause: 'budget',
        detail: EXHAUSTED_DETAIL
    };
}

describe('receipt ends (D56, R-S3a-4)', () => {
    it('ends a receiver receipt that ran out of retries failed, keeping who confirmed and who did not', () => {
        const next = computeALDeliveryLifecycle(
            createAdmittedLifecycle(),
            toReceiptExhausted('receiver', ['b'], ['c'])
        );

        expect(next.state).toBe('failed');
        expect(isALDeliveryTerminal(next)).toBe(true);
        expect(next.evidence).toMatchObject({
            reason: EXHAUSTED_DETAIL,
            receiptMode: 'receiver',
            expectedRecipientPeerIds: ['b', 'c'],
            confirmedRecipientPeerIds: ['b'],
            unconfirmedRecipientPeerIds: ['c'],
            // Under `receiver` the row names recipients; the hop view stays what the last receipt stated.
            confirmedHopPeerIds: [],
            unconfirmedHopPeerIds: []
        });
    });

    it('states the peer lists of a hop receipt as its hop lists too', () => {
        const next = computeALDeliveryLifecycle(
            createAdmittedLifecycle(),
            toReceiptExhausted('hop', ['relay-1'], ['relay-2'])
        );

        expect(next.evidence).toMatchObject({
            receiptMode: 'hop',
            confirmedHopPeerIds: ['relay-1'],
            unconfirmedHopPeerIds: ['relay-2'],
            expectedRecipientPeerIds: ['relay-1', 'relay-2'],
            confirmedRecipientPeerIds: ['relay-1'],
            unconfirmedRecipientPeerIds: ['relay-2']
        });
    });

    it('never reopens an acknowledged handle with a late exhaustion', () => {
        const acknowledged = computeALDeliveryLifecycle(createAdmittedLifecycle(), {
            kind: 'acknowledgement',
            msgId: MSG_ID,
            carrier: 'rtc',
            atMs: AT_MS,
            mode: 'receiver',
            confirmedHopPeerIds: ['b'],
            unconfirmedHopPeerIds: [],
            expectedRecipientPeerIds: ['b'],
            confirmedRecipientPeerIds: ['b'],
            unconfirmedRecipientPeerIds: [],
            complete: true
        });

        const late = computeALDeliveryLifecycle(
            acknowledged,
            toReceiptExhausted('receiver', [], ['b'])
        );

        expect(late).toMatchObject({ state: 'acknowledged', lateSettlementCount: 1 });
        expect(late.evidence.confirmedRecipientPeerIds).toEqual(['b']);
    });

    it('records a not-yet-in-sync exhaustion as a fact that ends nothing on its own', () => {
        const admitted = createAdmittedLifecycle();

        const next = computeALDeliveryLifecycle(admitted, {
            kind: 'not-yet-in-sync-exhausted',
            msgId: MSG_ID,
            carrier: 'rtc',
            atMs: AT_MS,
            detail: 'The not-yet-in-sync retry budget of 3 ran out.'
        });

        expect(next).toEqual(admitted);
        expect(next).not.toBe(admitted);
    });
});
