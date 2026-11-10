import { describe, expect, it } from 'vitest';

import { newALAckControlMessage, type ALAckPayload } from '@shared/al-contracts/al-control.ts';
import type { ALReceiptControl } from '@shared/al-contracts/receipt-proof/al-receipt-proof.ts';
import { RtcReceiptProofSigner } from '@shared/multicast/receipt-proof/rtc-receipt-proof-signer.ts';

import { toTestALAckPayload, verifyTestALReceiptControl } from '../../../al-control-test-payloads.ts';
import {
    createAvailablePublicationCryptoFixture,
    UNAVAILABLE_PUBLICATION_CRYPTO
} from '../../signature/publication-crypto-fixtures.ts';

const ACK: ALAckPayload = toTestALAckPayload({
    ackedMsgId: 'message-1',
    fromPeerId: 'recipient',
    toPeerId: 'origin',
    status: 'delivered'
});

describe('RtcReceiptProofSigner', () => {
    it('signs with the session\'s key pair', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const control: ALReceiptControl = { type: 'ack', payload: ACK };

        const proof = (await new RtcReceiptProofSigner({ crypto }).signReceiptProof(control)).right;

        expect(proof).toMatchObject({ alg: 'ES256', keyId: crypto.keyPair.keyId });
        const signed = newALAckControlMessage(
            { v: 4, msgId: 'ack-1', senderId: 'recipient', ts: 1, traceId: 'trace-rtc-receipt-proof-signer' },
            { ...ACK, proof: proof! }
        );
        expect(await verifyTestALReceiptControl(crypto, signed)).toBe(true);
    });

    it('answers signing-unavailable on a page without WebCrypto', async () => {
        const signer = new RtcReceiptProofSigner({ crypto: UNAVAILABLE_PUBLICATION_CRYPTO });

        const signed = await signer.signReceiptProof({ type: 'ack', payload: ACK });

        expect(signed.left).toMatchObject({ kind: 'signing-unavailable' });
    });
});
