import { describe, expect, it } from 'vitest';

import { decodeBase64Url, toBase64Url } from '@shared/encoding/base64url.ts';
import {
    computeEcdsaP256JwkThumbprint,
    createSigningKeyPair,
    decodeEcdsaP256PublicJwk,
    importEcdsaP256PublicKey,
    signDetached,
    verifyDetached,
    type EcdsaP256PublicJwk,
    type SigningKeyPair
} from '@shared/signature/ecdsa-p256-signature.ts';

const subtle = globalThis.crypto.subtle;

// RFC 7517 Appendix A.1 / A.2: its public key and its thumbprint computed per RFC 7638.
const RFC_7517_PUBLIC_JWK: EcdsaP256PublicJwk = {
    kty: 'EC',
    crv: 'P-256',
    x: 'MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4',
    y: '4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM'
};
const RFC_7517_THUMBPRINT = 'cn-I_WNMClehiVp51i_0VpOENW1upEerA8sEam5hn-s';
const RFC_7517_PRIVATE_D = '870MB6gfuTJ4HtUnUvYMyJpr5eUZNP4Bk43bVdj3eAE';

const message = new TextEncoder().encode('granted frame bytes');

async function createKeyPair(): Promise<SigningKeyPair> {
    return (await createSigningKeyPair(subtle)).fold(
        (failure) => {
            throw new Error(failure.message);
        },
        (pair) => pair
    );
}

async function importPublicKey(jwk: EcdsaP256PublicJwk): Promise<CryptoKey> {
    return (await importEcdsaP256PublicKey(subtle, jwk)).fold(
        (failure) => {
            throw new Error(failure.message);
        },
        (key) => key
    );
}

async function sign(pair: SigningKeyPair, bytes: Uint8Array): Promise<string> {
    return (await signDetached(subtle, pair.privateKey, bytes)).fold(
        (failure) => {
            throw new Error(failure.message);
        },
        (signature) => signature
    );
}

function toAlteredSignature(signature: string, alter: (bytes: Uint8Array) => Uint8Array): string {
    const bytes = decodeBase64Url(signature).right;
    if (bytes === undefined) {
        throw new Error('Expected a decodable signature.');
    }
    return toBase64Url(alter(bytes.slice()));
}

describe('ECDSA P-256 detached signatures', () => {
    it('verifies a signature over the signed bytes with the attested public key', async () => {
        const pair = await createKeyPair();
        const signature = await sign(pair, message);
        const publicKey = await importPublicKey(pair.publicJwk);

        expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/u);
        expect(Object.keys(pair.publicJwk).toSorted()).toEqual(['crv', 'kty', 'x', 'y']);
        expect(pair.keyId).toBe(await computeEcdsaP256JwkThumbprint(subtle, pair.publicJwk));
        expect(pair.keyId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect((await verifyDetached({ subtle, publicKey, bytes: message, signature })).right).toBe('verified');
    });

    it('never exports the private key', async () => {
        const pair = await createKeyPair();

        expect(pair.privateKey.extractable).toBe(false);
        await expect(subtle.exportKey('jwk', pair.privateKey)).rejects.toThrow();
    });

    it('refuses altered bytes, an altered or truncated signature and another key', async () => {
        const pair = await createKeyPair();
        const other = await createKeyPair();
        const signature = await sign(pair, message);
        const publicKey = await importPublicKey(pair.publicJwk);
        const alteredMessage = message.slice();
        alteredMessage[0] = (alteredMessage[0] ?? 0) ^ 1;
        const cases = [
            { bytes: alteredMessage, signature },
            { bytes: message, signature: toAlteredSignature(signature, (bytes) => bytes.map((byte, index) => index === 7 ? byte ^ 1 : byte)) },
            { bytes: message, signature: toAlteredSignature(signature, (bytes) => bytes.slice(0, 63)) },
            { bytes: message, signature: signature.slice(0, 85) },
            { bytes: message, signature: await sign(other, message) }
        ];

        for (const tampered of cases) {
            const outcome = await verifyDetached({ subtle, publicKey, ...tampered });

            expect(outcome.left?.kind).toBe('invalid-signature');
        }
    });

    it('refuses a signature text whose unused trailing bits are not zero', async () => {
        const pair = await createKeyPair();
        const signature = await sign(pair, message);
        const publicKey = await importPublicKey(pair.publicJwk);
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        const lastDigit = alphabet.indexOf(signature.at(-1) ?? 'A');
        const noncanonical = `${signature.slice(0, -1)}${alphabet[lastDigit ^ 1]}`;

        expect((await verifyDetached({ subtle, publicKey, bytes: message, signature })).right).toBe('verified');
        expect((await verifyDetached({ subtle, publicKey, bytes: message, signature: noncanonical })).left?.kind)
            .toBe('invalid-signature');
    });

    it('reports a key WebCrypto cannot verify with as an invalid key', async () => {
        const pair = await createKeyPair();
        const signature = await sign(pair, message);
        const outcome = await verifyDetached({ subtle, publicKey: pair.privateKey, bytes: message, signature });

        expect(outcome.left?.kind).toBe('invalid-key');
    });

    it('reports a key WebCrypto cannot sign with as a signing failure', async () => {
        const publicKey = await importPublicKey((await createKeyPair()).publicJwk);
        const outcome = await signDetached(subtle, publicKey, message);

        expect(outcome.left?.kind).toBe('sign-failed');
    });

    it('reports a missing SubtleCrypto as a failure value', async () => {
        const outcome = await createSigningKeyPair(undefined);

        expect(outcome.left?.kind).toBe('subtle-unavailable');
    });

    it('reports a public key WebCrypto refuses as an invalid key', async () => {
        const outcome = await importEcdsaP256PublicKey(subtle, { ...RFC_7517_PUBLIC_JWK, y: RFC_7517_PUBLIC_JWK.x });

        expect(outcome.left?.kind).toBe('invalid-key');
    });

    it('computes the RFC 7638 thumbprint of a fixed key', async () => {
        expect(await computeEcdsaP256JwkThumbprint(subtle, RFC_7517_PUBLIC_JWK)).toBe(RFC_7517_THUMBPRINT);
    });
});

describe('ECDSA P-256 public JWK decoding', () => {
    it('accepts exactly the four public members', () => {
        expect(decodeEcdsaP256PublicJwk({ ...RFC_7517_PUBLIC_JWK }).right).toEqual(RFC_7517_PUBLIC_JWK);
    });

    it('refuses a private member, a wrong curve and a short coordinate, reporting every issue', () => {
        const outcome = decodeEcdsaP256PublicJwk({
            ...RFC_7517_PUBLIC_JWK,
            crv: 'P-384',
            x: toBase64Url(new Uint8Array(31)),
            d: RFC_7517_PRIVATE_D
        });

        expect(outcome.left?.map((issue) => [issue.path, issue.code])).toEqual([
            ['$.d', 'unexpected-key'],
            ['$.crv', 'invalid-crv'],
            ['$.x', 'invalid-coordinate']
        ]);
    });

    it('refuses a missing member, a wrong key type and a value that is not an object', () => {
        const { y: _y, ...withoutY } = RFC_7517_PUBLIC_JWK;

        expect(decodeEcdsaP256PublicJwk({ ...withoutY, kty: 'RSA' }).left?.map((issue) => [issue.path, issue.code]))
            .toEqual([
                ['$.y', 'missing-key'],
                ['$.kty', 'invalid-kty']
            ]);
        expect(decodeEcdsaP256PublicJwk('jwk').left?.map((issue) => issue.code)).toEqual(['invalid-record']);
    });
});
