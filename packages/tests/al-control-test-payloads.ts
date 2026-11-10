import type { ALAckPayload, ALNackPayload } from '@shared/al-contracts/al-control.ts';
import { signALReceiptProof, type ALReceiptControl } from '@shared/al-contracts/receipt-proof/al-receipt-proof.ts';

import type { AvailablePublicationCrypto } from './shared/signature/publication-crypto-fixtures.ts';

export type TestALAckFields =
    & Pick<ALAckPayload, 'ackedMsgId' | 'fromPeerId' | 'toPeerId'>
    & Partial<ALAckPayload>;

/**
 * Defaults: originPeerId = toPeerId, logicalRecipientPeerId = fromPeerId, carrier 'rtc', status 'delivered',
 * observedAtEpochMs 1, proof null.
 */
export function toTestALAckPayload(fields: TestALAckFields): ALAckPayload {
    return {
        originPeerId: fields.toPeerId,
        logicalRecipientPeerId: fields.fromPeerId,
        carrier: 'rtc',
        status: 'delivered',
        observedAtEpochMs: 1,
        proof: null,
        ...fields
    };
}

export type TestALNackFields =
    & Pick<ALNackPayload, 'msgId' | 'fromPeerId' | 'toPeerId' | 'reason'>
    & Partial<ALNackPayload>;

/** Defaults: logicalRecipientPeerId = fromPeerId, originPeerId = toPeerId, observedAtEpochMs 1, proof null. */
export function toTestALNackPayload(fields: TestALNackFields): ALNackPayload {
    return {
        logicalRecipientPeerId: fields.fromPeerId,
        originPeerId: fields.toPeerId,
        observedAtEpochMs: 1,
        proof: null,
        ...fields
    };
}

/** The control with the proof a real signer over the crypto's key gives it; a refused signature fails the test. */
export async function signTestALReceiptControl(
    crypto: AvailablePublicationCrypto,
    control: ALReceiptControl
): Promise<ALReceiptControl> {
    const proof = (await signALReceiptProof({ subtle: crypto.subtle, keyPair: crypto.keyPair, control })).fold(
        (failure) => {
            throw new Error(failure.message);
        },
        (signed) => signed
    );
    return control.type === 'ack'
        ? { type: 'ack', payload: { ...control.payload, proof } }
        : { type: 'nack', payload: { ...control.payload, proof } };
}
