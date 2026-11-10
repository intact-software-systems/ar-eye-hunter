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
import { importEcdsaP256PublicKey, type SigningKeyPair } from '@shared/signature/ecdsa-p256-signature.ts';
import type { SignedFieldClass } from '@shared/signature/to-classified-signing-input.ts';

import { toTestALAckPayload, toTestALNackPayload } from '../../../al-control-test-payloads.ts';
import { createAvailablePublicationCryptoFixture } from '../../signature/publication-crypto-fixtures.ts';

const subtle = globalThis.crypto.subtle;

const ACK: ALReceiptControl = {
    type: 'ack',
    payload: toTestALAckPayload({
        ackedMsgId: 'm1',
        fromPeerId: 'r',
        toPeerId: 'a',
        originPeerId: 'a',
        logicalRecipientPeerId: 'c',
        status: 'delivered',
        observedAtEpochMs: 1_700_000_000_000
    })
};

const NACK: ALReceiptControl = {
    type: 'nack',
    payload: toTestALNackPayload({
        msgId: 'm1',
        fromPeerId: 'r',
        toPeerId: 'a',
        originPeerId: 'a',
        logicalRecipientPeerId: 'c',
        reason: 'not-subscribed',
        observedAtEpochMs: 1_700_000_000_000
    })
};

const GAP_NACK: ALReceiptControl = {
    type: 'nack',
    payload: {
        ...NACK.payload,
        reason: 'gap',
        orderingKey: 'room-1',
        expectedSeq: 3,
        missingRanges: [{ from: 3, to: 4 }]
    } as ALNackPayload
};

const ACK_ALTERATIONS: readonly (readonly [string, Partial<ALAckPayload>])[] = [
    ['ackedMsgId', { ackedMsgId: 'm2' }],
    ['originPeerId', { originPeerId: 'b' }],
    ['logicalRecipientPeerId', { logicalRecipientPeerId: 'd' }],
    ['status', { status: 'failed' as ALAckPayload['status'] }],
    ['observedAtEpochMs', { observedAtEpochMs: 1_700_000_000_001 }]
];

const NACK_ALTERATIONS: readonly (readonly [string, Partial<ALNackPayload>])[] = [
    ['msgId', { msgId: 'm2' }],
    ['originPeerId', { originPeerId: 'b' }],
    ['logicalRecipientPeerId', { logicalRecipientPeerId: 'd' }],
    ['reason', { reason: 'gap' }],
    ['observedAtEpochMs', { observedAtEpochMs: 1_700_000_000_001 }],
    ['orderingKey', { orderingKey: 'room-2' }],
    ['expectedSeq', { expectedSeq: 9 }],
    ['missingRanges', { missingRanges: [{ from: 1, to: 2 }] }],
    ['serverSnapshotVersion', { serverSnapshotVersion: 7 }]
];

const RELAY_REWRITES: readonly (readonly [string, Partial<ALAckPayload>])[] = [
    ['fromPeerId', { fromPeerId: 'relay' }],
    ['toPeerId', { toPeerId: 'upstream' }],
    ['carrier', { carrier: 'ws' }]
];

async function createCryptoAndSigned(control: ALReceiptControl): Promise<{
    readonly keyPair: SigningKeyPair;
    readonly publicKey: CryptoKey;
    readonly signed: ALReceiptControl;
}> {
    const crypto = await createAvailablePublicationCryptoFixture();
    const proof = (await signALReceiptProof({ subtle, keyPair: crypto.keyPair, control })).fold(
        (failure) => {
            throw new Error(failure.message);
        },
        (value) => value
    );
    const publicKey = (await importEcdsaP256PublicKey(subtle, crypto.keyPair.publicJwk)).fold(
        (failure) => {
            throw new Error(failure.message);
        },
        (value) => value
    );
    return { keyPair: crypto.keyPair, publicKey, signed: withProof(control, proof) };
}

function withProof(control: ALReceiptControl, proof: ALAckPayload['proof']): ALReceiptControl {
    return control.type === 'ack'
        ? { type: 'ack', payload: { ...control.payload, proof } }
        : { type: 'nack', payload: { ...control.payload, proof } };
}

function withPayload(control: ALReceiptControl, change: Partial<ALAckPayload> | Partial<ALNackPayload>): ALReceiptControl {
    return control.type === 'ack'
        ? { type: 'ack', payload: { ...control.payload, ...change } as ALAckPayload }
        : { type: 'nack', payload: { ...control.payload, ...change } as ALNackPayload };
}

describe('ALM receipt proof signing input', () => {
    it('pins the ACK signing input', () => {
        expect(AL_ACK_PROOF_DOMAIN_TAG).toBe('rallar-alm-ack-proof-v1');
        expect(toALReceiptProofSigningInput(ACK)).toBe('["rallar-alm-ack-proof-v1","m1","a","c","delivered",1700000000000]');
    });

    it('pins the NACK signing input, an absent hint null', () => {
        expect(AL_NACK_PROOF_DOMAIN_TAG).toBe('rallar-alm-nack-proof-v1');
        expect(toALReceiptProofSigningInput(NACK)).toBe(
            '["rallar-alm-nack-proof-v1","m1","a","c","not-subscribed",1700000000000,null,null,null,null]'
        );
        expect(toALReceiptProofSigningInput(GAP_NACK)).toBe(
            '["rallar-alm-nack-proof-v1","m1","a","c","gap",1700000000000,"room-1",3,[{"from":3,"to":4}],null]'
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
        const nackWithAckProof = withProof(NACK, signed.payload.proof);

        expect((await verifyALReceiptProof({ subtle, publicKey, control: nackWithAckProof })).left?.kind).toBe(
            'invalid-signature'
        );
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

    it('reports a key WebCrypto refuses to sign with as sign-failed, copying the primitive message', async () => {
        const { keyPair, publicKey } = await createCryptoAndSigned(ACK);
        const verifyOnly = { ...keyPair, privateKey: publicKey };

        expect((await signALReceiptProof({ subtle, keyPair: verifyOnly, control: ACK })).left).toEqual({
            kind: 'sign-failed',
            message: expect.stringMatching(/^Signing was refused: /)
        });
    });
});
