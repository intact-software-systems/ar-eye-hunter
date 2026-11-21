import { describe, expect, expectTypeOf, it } from 'vitest';

import type { ALAckPayload, ALNackPayload } from '@shared/al-contracts/al-control.ts';
import {
    AL_ACK_PROOF_DOMAIN_TAG,
    AL_NACK_PROOF_DOMAIN_TAG,
    AL_RECEIPT_PROOF_FIELD_CLASSES,
    signALReceiptProof,
    toALReceiptProofSigningInput,
    verifyALReceiptProof,
    type ALReceiptControl
} from '@shared/al-contracts/receipt-proof/al-receipt-proof.ts';
import { importEcdsaP256PublicKey, signDetached, type SigningKeyPair } from '@shared/signature/ecdsa-p256-signature.ts';
import { toClassifiedSigningInput, type SignedFieldClass } from '@shared/signature/to-classified-signing-input.ts';

import { signTestALReceiptControl } from '../../../al-control-test-payloads.ts';
import { createAvailablePublicationCryptoFixture } from '../../signature/publication-crypto-fixtures.ts';
import { ACK, ACK_ALTERATIONS, GAP_NACK, NACK, NACK_ALTERATIONS, RELAY_REWRITES, withPayload } from './al-receipt-proof-fixtures.ts';

const subtle = globalThis.crypto.subtle;

async function toPublicKey(keyPair: SigningKeyPair): Promise<CryptoKey> {
    return (await importEcdsaP256PublicKey(subtle, keyPair.publicJwk)).fold(
        (failure) => {
            throw new Error(failure.message);
        },
        (value) => value
    );
}

async function createCryptoAndSigned(control: ALReceiptControl): Promise<{
    readonly keyPair: SigningKeyPair;
    readonly publicKey: CryptoKey;
    readonly signed: ALReceiptControl;
}> {
    const crypto = await createAvailablePublicationCryptoFixture();
    const publicKey = await toPublicKey(crypto.keyPair);
    return { keyPair: crypto.keyPair, publicKey, signed: await signTestALReceiptControl(crypto, control) };
}

describe('ALM receipt proof signing input', () => {
    it('pins the ACK signing input', () => {
        expect(AL_ACK_PROOF_DOMAIN_TAG).toBe('rallar-alm-ack-proof-v1');
        expect(toALReceiptProofSigningInput(ACK)).toBe('["rallar-alm-ack-proof-v1","m1","a","c","delivered",1700000000000]');
    });

    it('pins the NACK signing input, an absent hint null', () => {
        expect(AL_NACK_PROOF_DOMAIN_TAG).toBe('rallar-alm-nack-proof-v2');
        expect(toALReceiptProofSigningInput(NACK)).toBe(
            '["rallar-alm-nack-proof-v2","m1","a","c","not-subscribed",1700000000000,null,null,null,null,null]'
        );
        expect(toALReceiptProofSigningInput(GAP_NACK)).toBe(
            '["rallar-alm-nack-proof-v2","m1","a","c","gap",1700000000000,"room-1",3,[{"from":3,"to":4}],1,null]'
        );
    });

    it('classifies every ACK and NACK key, so an added key fails the build unclassified', () => {
        const classes = AL_RECEIPT_PROOF_FIELD_CLASSES;

        expectTypeOf<keyof typeof classes.ack>().toEqualTypeOf<keyof ALAckPayload>();
        expectTypeOf<keyof typeof classes.nack>().toEqualTypeOf<keyof ALNackPayload>();
        // @ts-expect-error a key the record does not classify fails the satisfies check
        expect(classes.ack satisfies Record<keyof ALAckPayload | 'added', SignedFieldClass>).toBeDefined();
        expect(classes.ack).toMatchObject({ carrier: 'excluded', proof: 'excluded', fromPeerId: 'excluded' });
        expect(classes.nack).toMatchObject({ proof: 'excluded', toPeerId: 'excluded' });
    });
});

describe('ALM receipt proof signing and verification', () => {
    it('signs and verifies an ACK and a NACK', async () => {
        for (const control of [ACK, GAP_NACK]) {
            const { keyPair, publicKey, signed } = await createCryptoAndSigned(control);

            expect(signed.payload.proof).toEqual({ alg: 'ES256', keyId: keyPair.keyId, signature: expect.any(String) });
            expect(signed.payload.proof?.signature).toHaveLength(86);
            expect((await verifyALReceiptProof({ subtle, publicKey, control: signed })).right).toBe(true);
        }
    });

    it('refuses a control that carries no proof as invalid-signature', async () => {
        const { publicKey } = await createCryptoAndSigned(ACK);

        expect((await verifyALReceiptProof({ subtle, publicKey, control: ACK })).left).toEqual({
            kind: 'invalid-signature',
            message: expect.any(String)
        });
    });

    it('never verifies an ACK\'s signature as a NACK\'s', async () => {
        const { publicKey, signed } = await createCryptoAndSigned(ACK);
        const nackWithAckProof: ALReceiptControl = { type: 'nack', payload: { ...NACK.payload, proof: signed.payload.proof } };

        expect((await verifyALReceiptProof({ subtle, publicKey, control: nackWithAckProof })).left?.kind).toBe(
            'invalid-signature'
        );
    });

    it('refuses a signature made over the same fields under the other domain tag', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const publicKey = await toPublicKey(crypto.keyPair);
        const otherTagInput = toClassifiedSigningInput(AL_NACK_PROOF_DOMAIN_TAG, [
            { name: 'ack', fields: { ...ACK.payload }, classes: AL_RECEIPT_PROOF_FIELD_CLASSES.ack }
        ]);
        const signature = (await signDetached(subtle, crypto.keyPair.privateKey, new TextEncoder().encode(otherTagInput))).fold(
            (failure) => {
                throw new Error(failure.message);
            },
            (value) => value
        );
        const otherTagAck: ALReceiptControl = {
            type: 'ack',
            payload: { ...ACK.payload, proof: { alg: 'ES256', keyId: crypto.keyPair.keyId, signature } }
        };
        const sameTagControl = await signTestALReceiptControl(crypto, ACK);

        expect(AL_ACK_PROOF_DOMAIN_TAG).not.toBe(AL_NACK_PROOF_DOMAIN_TAG);
        expect((await verifyALReceiptProof({ subtle, publicKey, control: otherTagAck })).left?.kind).toBe(
            'invalid-signature'
        );
        expect((await verifyALReceiptProof({ subtle, publicKey, control: sameTagControl })).right).toBe(true);
    });

    it.each(ACK_ALTERATIONS)('refuses an ACK whose %s was altered', async (_field, change) => {
        const { publicKey, signed } = await createCryptoAndSigned(ACK);

        expect((await verifyALReceiptProof({ subtle, publicKey, control: withPayload(signed, change) })).left?.kind).toBe(
            'invalid-signature'
        );
    });

    it.each(NACK_ALTERATIONS)('refuses a NACK whose %s was altered', async (_field, change) => {
        const { publicKey, signed } = await createCryptoAndSigned(NACK);

        expect((await verifyALReceiptProof({ subtle, publicKey, control: withPayload(signed, change) })).left?.kind).toBe(
            'invalid-signature'
        );
    });

    it.each(RELAY_REWRITES)('still verifies a control whose %s a relay rewrote', async (_field, change) => {
        const { publicKey, signed } = await createCryptoAndSigned(ACK);

        expect((await verifyALReceiptProof({ subtle, publicKey, control: withPayload(signed, change) })).right).toBe(true);
    });

    it.each(['fromPeerId', 'toPeerId'] as const)('still verifies a NACK whose %s a relay rewrote', async (field) => {
        const { publicKey, signed } = await createCryptoAndSigned(NACK);

        expect((await verifyALReceiptProof({ subtle, publicKey, control: withPayload(signed, { [field]: 'rewritten' }) })).right).toBe(true);
    });

    it('refuses a gap NACK whose gap request number was altered after signing', async () => {
        const { publicKey, signed } = await createCryptoAndSigned(GAP_NACK);

        expect((await verifyALReceiptProof({ subtle, publicKey, control: withPayload(signed, { gapRequestNumber: 2 }) })).left?.kind)
            .toBe('invalid-signature');
    });

    it('still verifies a gap NACK whose fromPeerId and toPeerId a relay rewrote', async () => {
        const { publicKey, signed } = await createCryptoAndSigned(GAP_NACK);
        const relayed = withPayload(signed, { fromPeerId: 'relay', toPeerId: 'upstream' });

        expect((await verifyALReceiptProof({ subtle, publicKey, control: relayed })).right).toBe(true);
    });

    it('reports a key WebCrypto refuses to sign with as sign-failed, copying the primitive message', async () => {
        const { keyPair, publicKey } = await createCryptoAndSigned(ACK);
        const verifyOnly = { ...keyPair, privateKey: publicKey };

        expect((await signALReceiptProof({ subtle, keyPair: verifyOnly, control: ACK })).left).toEqual({
            kind: 'sign-failed',
            message: expect.stringMatching(/^Signing was refused: /)
        });
    });
});
