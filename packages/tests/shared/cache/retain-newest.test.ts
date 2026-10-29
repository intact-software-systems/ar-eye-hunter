import { retainNewest } from '@shared/cache/retain-newest.ts';
import { describe, expect, it } from 'vitest';

describe('retainNewest', () => {
    it('retains nothing and displaces nothing for empty input', () => {
        expect(retainNewest([], 3)).toEqual({ retained: [], displaced: [] });
    });

    it('retains every value while the input fits the limit', () => {
        expect(retainNewest(['v1', 'v2'], 3)).toEqual({ retained: ['v1', 'v2'], displaced: [] });
        expect(retainNewest(['v1', 'v2', 'v3'], 3)).toEqual({ retained: ['v1', 'v2', 'v3'], displaced: [] });
    });

    it('keeps only the newest value at limit 1 and displaces the rest oldest first', () => {
        expect(retainNewest(['v1'], 1)).toEqual({ retained: ['v1'], displaced: [] });
        expect(retainNewest(['v1', 'v2'], 1)).toEqual({ retained: ['v2'], displaced: ['v1'] });
        expect(retainNewest(['v1', 'v2', 'v3'], 1)).toEqual({ retained: ['v3'], displaced: ['v1', 'v2'] });
    });

    it('keeps the newest three oldest first and displaces what fell off oldest first', () => {
        expect(retainNewest(['v1', 'v2', 'v3', 'v4'], 3)).toEqual({
            retained: ['v2', 'v3', 'v4'],
            displaced: ['v1']
        });
        expect(retainNewest(['v1', 'v2', 'v3', 'v4', 'v5'], 3)).toEqual({
            retained: ['v3', 'v4', 'v5'],
            displaced: ['v1', 'v2']
        });
    });

    it('does not change its input', () => {
        const values = ['v1', 'v2', 'v3'];

        retainNewest(values, 2);

        expect(values).toEqual(['v1', 'v2', 'v3']);
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects the limit %s as a programmer error', (limit) => {
        expect(() => retainNewest(['v1'], limit)).toThrow('limit must be a positive safe integer');
    });
});
