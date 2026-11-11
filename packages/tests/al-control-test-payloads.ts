import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALPeerControlMessage, type ALAckPayload, type ALNackPayload } from '@shared/al-contracts/al-control.ts';
import {
    signALReceiptProof,
    verifyALReceiptProof,
    type ALReceiptControl
} from '@shared/al-contracts/receipt-proof/al-receipt-proof.ts';
import { importEcdsaP256PublicKey } from '@shared/signature/ecdsa-p256-signature.ts';
import type { SignatureProof } from '@shared/signature/signature-proof.ts';

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

/** A proof of the persisted ES256 shape that verifies under no key: key id 43 × 'A', signature `index.toString(36).padStart(85, 'A') + 'A'`. */
export function toTestSignatureProof(index: number): SignatureProof {
    return { alg: 'ES256', keyId: 'A'.repeat(43), signature: `${index.toString(36).padStart(85, 'A')}A` };
}

/** The control with the proof a real signer over the crypto's key gives it; a refused signature fails the test. */
export async function signTestALReceiptControl<TControl extends ALReceiptControl>(
    crypto: AvailablePublicationCrypto,
    control: TControl
): Promise<TControl> {
    const proof = (await signALReceiptProof({ subtle: crypto.subtle, keyPair: crypto.keyPair, control })).fold(
        (failure) => {
            throw new Error(failure.message);
        },
        (signed) => signed
    );
    return { ...control, payload: { ...control.payload, proof } };
}

/** Whether `msg` is an ACK or NACK whose proof verifies against the crypto's own public key. */
export async function verifyTestALReceiptControl(crypto: AvailablePublicationCrypto, msg: ALMessage): Promise<boolean> {
    const control = decodeALPeerControlMessage(msg).right;
    const publicKey = (await importEcdsaP256PublicKey(crypto.subtle, crypto.keyPair.publicJwk)).right;
    if (control === undefined || control.type === 'repair' || publicKey === undefined) {
        return false;
    }
    return (await verifyALReceiptProof({ subtle: crypto.subtle, publicKey, control })).right === true;
}
