import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';

import { decodeBase64Any, decodeBase64Url, isBase64UrlOfByteLength, toBase64Url } from '@shared/encoding/base64url.ts';

const INVALID_BASE64URL = [{ path: '$', code: 'invalid-base64url', message: expect.any(String) }];
const INVALID_BASE64 = [{ path: '$', code: 'invalid-base64', message: expect.any(String) }];

function toBytes(length: number): Uint8Array {
    return Uint8Array.from({ length }, (_, index) => (index * 151 + 7) % 256);
}

describe('base64url', () => {
    it.each([
        ['', ''],
        ['f', 'Zg'],
        ['fo', 'Zm8'],
        ['foo', 'Zm9v'],
        ['foob', 'Zm9vYg'],
        ['fooba', 'Zm9vYmE'],
        ['foobar', 'Zm9vYmFy']
    ])('encodes the RFC 4648 vector %j as unpadded %j and decodes it back', (plain, encoded) => {
        const bytes = new TextEncoder().encode(plain);

        expect(toBase64Url(bytes)).toBe(encoded);
        expect(decodeBase64Url(encoded).right).toEqual(bytes);
    });

    it('uses the URL-safe alphabet for the two final digits', () => {
        expect(toBase64Url(Uint8Array.of(0xfb, 0xff, 0xbf))).toBe('-_-_');
        expect(decodeBase64Url('-_-_').right).toEqual(Uint8Array.of(0xfb, 0xff, 0xbf));
    });

    it('round-trips every length from 0 to 65 bytes and agrees with the platform encoder', () => {
        for (let length = 0; length <= 65; length += 1) {
            const bytes = toBytes(length);
            const encoded = toBase64Url(bytes);

            expect(encoded).toBe(Buffer.from(bytes).toString('base64url'));
            expect(decodeBase64Url(encoded).right).toEqual(bytes);
        }
    });

    it.each(['Zm9v+g', 'Zm9v/g', 'Zg==', 'Zm 9v', 'Zm9v.'])('refuses %j outside the strict unpadded alphabet', (text) => {
        expect(decodeBase64Url(text).left).toEqual(INVALID_BASE64URL);
    });

    it.each(['Z', 'Zm9vY'])('refuses %j whose length cannot encode whole bytes', (text) => {
        expect(decodeBase64Url(text).left).toEqual(INVALID_BASE64URL);
    });

    it.each([
        ['Zg', 'Zh'],
        ['Zm8', 'Zm9'],
        ['-_-_Zg', '-_-_Zp']
    ])('accepts canonical %j and refuses %j, whose unused trailing bits are not zero', (canonical, noncanonical) => {
        expect(decodeBase64Url(canonical).right).toEqual(decodeBase64Any(noncanonical).right);
        expect(decodeBase64Url(noncanonical).left).toEqual(INVALID_BASE64URL);
    });

    it.each<[unknown, number, boolean]>([
        ['Zm9v', 3, true],
        ['Zm9v', 2, false],
        ['Zm9vYg', 4, true],
        ['Zm9vYh', 4, false],
        ['Zm9v+g', 4, false],
        [3, 3, false],
        [undefined, 0, false]
    ])('judges %j as strict base64url text of %d bytes: %s', (value, byteLength, expected) => {
        expect(isBase64UrlOfByteLength(value, byteLength)).toBe(expected);
    });
});

describe('base64 in either alphabet', () => {
    const bytes = Uint8Array.of(0xfb, 0xff, 0xbf, 0x66);

    it.each(['-_-_Zg', '+/+/Zg', '+/+/Zg==', '-_-_Zg==', '-/+_Zg'])('accepts %j in the standard or URL alphabet, padded or not', (text) => {
        expect(decodeBase64Any(text).right).toEqual(bytes);
    });

    it.each(['-_-_Zg=', 'Zg=', '-_-_Z', 'Zm9v.', 'Zg=a', '='])('refuses %j', (text) => {
        expect(decodeBase64Any(text).left).toEqual(INVALID_BASE64);
    });
});
