import { describe, expect, it } from 'vitest';

import { computeNearestRank, computeNearestRankIndex } from '@shared/measurement/compute-nearest-rank.ts';

describe('computeNearestRank', () => {
    it('reads the value at rank ceil(p·n) of the sorted values', () => {
        expect(computeNearestRank([5, 1, 4, 2, 3], 0.5)).toBe(3);
        const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        expect(computeNearestRank(ten, 0.95)).toBe(10);
        expect(computeNearestRank(ten, 0.9)).toBe(9);
    });

    it('reads the smallest value at fraction 0 and the largest at fraction 1', () => {
        expect(computeNearestRank([7, 3, 9], 0)).toBe(3);
        expect(computeNearestRank([7, 3, 9], -0.5)).toBe(3);
        expect(computeNearestRank([7, 3, 9], 1)).toBe(9);
        expect(computeNearestRank([7, 3, 9], 1.5)).toBe(9);
    });

    it('answers undefined for no values', () => {
        expect(computeNearestRank([], 0.5)).toBeUndefined();
    });

    it('answers undefined for a fraction that is not a finite number', () => {
        expect(computeNearestRank([1, 2, 3], Number.NaN)).toBeUndefined();
        expect(computeNearestRank([1, 2, 3], Number.POSITIVE_INFINITY)).toBeUndefined();
        expect(computeNearestRank([1, 2, 3], Number.NEGATIVE_INFINITY)).toBeUndefined();
    });

    it('does not reorder its input', () => {
        const values = [5, 1, 4, 2, 3];
        computeNearestRank(values, 0.5);
        expect(values).toEqual([5, 1, 4, 2, 3]);
    });

    it('reads one value for every fraction when it holds only one', () => {
        for (const fraction of [0, 0.25, 0.5, 0.99, 1]) {
            expect(computeNearestRank([42], fraction)).toBe(42);
        }
    });

    it('has no rank among a count that is below one or not a number', () => {
        for (const count of [0, -3, 0.5, Number.NaN]) {
            expect(computeNearestRankIndex(count, 0.5)).toBeUndefined();
        }
        expect(computeNearestRankIndex(1, 0.5)).toBe(0);
    });
});
