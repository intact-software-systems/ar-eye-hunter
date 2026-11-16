import { describe, expect, it } from 'vitest';

import { computeNumberExtrema } from '@shared/measurement/compute-number-extrema.ts';

describe('computeNumberExtrema', () => {
    it('reads the smallest and the largest value in any order', () => {
        expect(computeNumberExtrema([4, -2, 9, 0])).toEqual({ min: -2, max: 9 });
        expect(computeNumberExtrema([3])).toEqual({ min: 3, max: 3 });
    });

    it('is absent for no values', () => {
        expect(computeNumberExtrema([])).toBeUndefined();
    });
});
