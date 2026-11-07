import { test } from 'bun:test';
import assert from 'node:assert/strict';

import {
    computeEcdsaP256JwkThumbprint,
    createSigningKeyPair,
    decodeEcdsaP256PublicJwk,
    importEcdsaP256PublicKey,
    signDetached,
    verifyDetached,
    type EcdsaP256PublicJwk
} from '@shared/signature/ecdsa-p256-signature.ts';

const subtle = globalThis.crypto.subtle;

// RFC 7517 Appendix A.1 / A.2: its public key and its thumbprint computed per RFC 7638.
const RFC_7517_PUBLIC_JWK: EcdsaP256PublicJwk = {
    kty: 'EC',
    crv: 'P-256',
    x: 'MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4',
    y: '4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM'
};

test('Deno WebCrypto signs and verifies an ECDSA P-256 detached signature', async () => {
    const message = new TextEncoder().encode('granted frame bytes');
    const pair = (await createSigningKeyPair(subtle)).right;
    assert.ok(pair);
    const signature = (await signDetached(subtle, pair.privateKey, message)).right;
    assert.ok(signature);
    const publicKey = (await importEcdsaP256PublicKey(subtle, pair.publicJwk)).right;
    assert.ok(publicKey);

    assert.equal(signature.length, 86);
    assert.equal(pair.keyId, await computeEcdsaP256JwkThumbprint(subtle, pair.publicJwk));
    assert.equal((await verifyDetached({ subtle, publicKey, bytes: message, signature })).right, 'verified');
    assert.equal(
        (await verifyDetached({ subtle, publicKey, bytes: new TextEncoder().encode('other'), signature })).left?.kind,
        'invalid-signature'
    );
});

test('Deno WebCrypto computes the RFC 7638 thumbprint of a fixed ECDSA P-256 key', async () => {
    assert.equal(
        await computeEcdsaP256JwkThumbprint(subtle, RFC_7517_PUBLIC_JWK),
        'cn-I_WNMClehiVp51i_0VpOENW1upEerA8sEam5hn-s'
    );
});

test('the ECDSA P-256 public JWK decoder accepts the public members and refuses a private one', () => {
    assert.deepEqual(decodeEcdsaP256PublicJwk({ ...RFC_7517_PUBLIC_JWK }).right, RFC_7517_PUBLIC_JWK);
    assert.deepEqual(
        decodeEcdsaP256PublicJwk({ ...RFC_7517_PUBLIC_JWK, d: '870MB6gfuTJ4HtUnUvYMyJpr5eUZNP4Bk43bVdj3eAE' }).left
            ?.map((issue) => issue.code),
        ['unexpected-key']
    );
});
