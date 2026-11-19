import { describe, expect, it } from 'vitest';

import { decodeCanonicalSubset } from '@shared/encoding/decode-canonical-subset.ts';

const KNOWN = ['first', 'second', 'third'] as const;

describe('decodeCanonicalSubset', () => {
    it('accepts a subset in the known order, the empty one included', () => {
        expect(decodeCanonicalSubset(['first', 'third'], KNOWN, 'Field').right).toEqual(['first', 'third']);
        expect(decodeCanonicalSubset([], KNOWN, 'Field').right).toEqual([]);
    });

    it('refuses a value that is not an array', () => {
        expect(decodeCanonicalSubset('first', KNOWN, 'Field').left).toBe('Field must be an array');
    });

    it.each([[['third', 'first']], [['first', 'first']], [['fourth']]])('refuses %j', (value) => {
        expect(decodeCanonicalSubset(value, KNOWN, 'Field').left).toBe('Field must be known, unique and in canonical order');
    });
});
