import { describe, expect, it } from 'vitest';

import { AL_MESSAGE_ENVELOPE_VERSION } from '@shared/al-contracts/al-contract.ts';
import { decodeALPeerControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALReceiptControl } from '@shared/al-contracts/receipt-proof/al-receipt-proof.ts';
import { toALForwardedReceiptControlMessage } from '@shared/alm/inbound/control/to-al-forwarded-receipt-control-message.ts';

import {
    signTestALReceiptControl,
    toTestALAckPayload,
    toTestALNackPayload,
    verifyTestALReceiptControl
} from '../../../../al-control-test-payloads.ts';
import { createAvailablePublicationCryptoFixture } from '../../../signature/publication-crypto-fixtures.ts';

const ID = { v: AL_MESSAGE_ENVELOPE_VERSION, msgId: 'forwarded-1', senderId: 'relay', ts: 9_000, traceId: 'trace-1' };
const HOP = { fromPeerId: 'relay', toPeerId: 'parent', carrier: 'ws' } as const;

const LEAF_ACK: ALReceiptControl = {
    type: 'ack',
    payload: toTestALAckPayload({
        ackedMsgId: 'subject',
        fromPeerId: 'leaf',
        toPeerId: 'relay',
        originPeerId: 'origin',
        logicalRecipientPeerId: 'leaf',
        carrier: 'rtc',
        status: 'delivered',
        observedAtEpochMs: 1_234
    })
};

const LEAF_GAP_NACK: ALReceiptControl = {
    type: 'nack',
    payload: toTestALNackPayload({
        msgId: 'subject',
        fromPeerId: 'leaf',
        toPeerId: 'relay',
        originPeerId: 'origin',
        logicalRecipientPeerId: 'leaf',
        reason: 'gap',
        observedAtEpochMs: 1_234,
        orderingKey: 'feed:origin:1',
        expectedSeq: 2,
        missingRanges: [{ from: 2, to: 3 }]
    })
};

describe('a child control a relay forwards upward', () => {
    it('keeps every signed field and the proof; the forwarded control still verifies', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const other = await createAvailablePublicationCryptoFixture();
        const signedAck = await signTestALReceiptControl(crypto, LEAF_ACK);
        const signedNack = await signTestALReceiptControl(crypto, LEAF_GAP_NACK);

        const ack = toALForwardedReceiptControlMessage(ID, signedAck, HOP);
        const nack = toALForwardedReceiptControlMessage(ID, signedNack, HOP);

        expect(ack.id).toEqual(ID);
        expect(decodeALPeerControlMessage(ack).right).toEqual({ type: 'ack', payload: { ...signedAck.payload, ...HOP } });
        expect(decodeALPeerControlMessage(nack).right).toEqual({
            type: 'nack',
            payload: { ...signedNack.payload, fromPeerId: HOP.fromPeerId, toPeerId: HOP.toPeerId }
        });
        expect([await verifyTestALReceiptControl(crypto, ack), await verifyTestALReceiptControl(crypto, nack)])
            .toEqual([true, true]);
        expect([await verifyTestALReceiptControl(other, ack), await verifyTestALReceiptControl(other, nack)])
            .toEqual([false, false]);
    });
});
