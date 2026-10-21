import { requireUnitRate } from '@shared-server/rallar-system/group-state/require-unit-rate.ts';
import { describe, expect, it } from 'vitest';

describe('group-state unit rate', () => {
    it.each([0, 0.5, 1])('accepts %s', (rate) => {
        expect(() => requireUnitRate(rate, 'Rate')).not.toThrow();
    });

    it.each([
        ['negative zero', -0],
        ['NaN', Number.NaN],
        ['infinity', Number.POSITIVE_INFINITY],
        ['a rate above one', 1.0000001],
        ['a negative rate', -0.1],
        ['a numeric string', '0.5'],
        ['null', null]
    ])('rejects %s', (_case, rate) => {
        expect(() => requireUnitRate(rate, 'Rate')).toThrow('Rate must be within [0, 1]');
    });
});
