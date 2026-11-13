import { describe, expect, it } from 'vitest';

import { computeUtf8ByteLength } from '@shared/encoding/compute-utf8-byte-length.ts';

describe('computeUtf8ByteLength', () => {
    it('counts ASCII as one byte each', () => {
        expect(computeUtf8ByteLength('abc')).toBe(3);
    });

    it('counts two-, three- and four-byte code points', () => {
        expect(computeUtf8ByteLength('é')).toBe(2);
        expect(computeUtf8ByteLength('€')).toBe(3);
        expect(computeUtf8ByteLength('😀')).toBe(4);
    });

    it('counts a lone surrogate as the three bytes of U+FFFD', () => {
        expect(computeUtf8ByteLength('\uD800')).toBe(3);
        expect(computeUtf8ByteLength('a\uDC00b')).toBe(5);
    });

    it('equals TextEncoder for a mixed string', () => {
        const mixed = 'room-é€😀-\uD800-ß漢字 end';
        expect(computeUtf8ByteLength(mixed)).toBe(new TextEncoder().encode(mixed).byteLength);
    });
});
