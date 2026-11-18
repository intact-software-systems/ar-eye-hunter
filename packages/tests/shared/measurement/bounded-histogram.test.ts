import { describe, expect, it } from 'vitest';

import {
    computeBoundedHistogramAfter,
    createBoundedHistogram,
    decodeBoundedHistogram,
    MAX_BOUNDED_HISTOGRAM_BOUNDS,
    type BoundedHistogram
} from '@shared/measurement/bounded-histogram.ts';

function createRecorded(upperBounds: readonly number[], values: readonly number[]): BoundedHistogram {
    let histogram = createBoundedHistogram(upperBounds).right!;
    for (const value of values) {
        histogram = computeBoundedHistogramAfter(histogram, value).right!;
    }
    return histogram;
}

describe('BoundedHistogram', () => {
    it('records each value into the first bucket whose upper bound holds it, and above the last bound into the overflow bucket', () => {
        expect(createRecorded([10, 100], [0]).bucketCounts).toEqual([1, 0, 0]);
        expect(createRecorded([10, 100], [10]).bucketCounts).toEqual([1, 0, 0]);
        expect(createRecorded([10, 100], [10.5]).bucketCounts).toEqual([0, 1, 0]);
        expect(createRecorded([10, 100], [101]).bucketCounts).toEqual([0, 0, 1]);
    });

    it('reads count, sum, min and max of what it recorded', () => {
        const histogram = createRecorded([10, 100], [5, 50, 500, 2]);
        expect(histogram.count).toBe(4);
        expect(histogram.sum).toBe(557);
        expect(histogram.min).toBe(2);
        expect(histogram.max).toBe(500);
    });

    it('keeps its bucket count fixed however many values it records', () => {
        const values = Array.from({ length: 10_000 }, (_, index) => index % 250);
        const histogram = createRecorded([10, 100], values);
        expect(histogram.bucketCounts.length).toBe(3);
        expect(histogram.count).toBe(10_000);
    });

    it('refuses a negative or non-finite value as a typed left and leaves the histogram as it was', () => {
        const histogram = createRecorded([10, 100], [5]);
        for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
            expect(computeBoundedHistogramAfter(histogram, value).left).toEqual(expect.any(String));
        }
        expect(histogram).toEqual(createRecorded([10, 100], [5]));
    });

    it('does not change the histogram it records into', () => {
        const before = createBoundedHistogram([10]).right!;
        computeBoundedHistogramAfter(before, 3);
        expect(before.count).toBe(0);
        expect(before.bucketCounts).toEqual([0, 0]);
    });

    it('refuses empty, unordered, repeated, negative, non-finite or too many bounds', () => {
        const tooMany = Array.from({ length: MAX_BOUNDED_HISTOGRAM_BOUNDS + 1 }, (_, index) => index);
        for (const bounds of [[], [10, 5], [5, 5], [-1, 5], [Number.NaN], [1, Number.POSITIVE_INFINITY], tooMany]) {
            expect(createBoundedHistogram(bounds).left).toEqual(expect.any(String));
        }
        const atMost = Array.from({ length: MAX_BOUNDED_HISTOGRAM_BOUNDS }, (_, index) => index);
        expect(createBoundedHistogram(atMost).right).toBeDefined();
    });

    it('reports an empty histogram with null min and max', () => {
        const histogram = createBoundedHistogram([10, 100]).right!;
        expect(histogram).toEqual({
            upperBounds: [10, 100],
            bucketCounts: [0, 0, 0],
            count: 0,
            sum: 0,
            min: null,
            max: null
        });
    });

    it('decodes what it records', () => {
        const recorded = createRecorded([10, 100], [1, 20, 300]);
        const decoded = decodeBoundedHistogram(JSON.parse(JSON.stringify(recorded)), 'figures.histogram');
        expect(decoded.right).toEqual(recorded);
        const empty = createBoundedHistogram([10]).right!;
        expect(decodeBoundedHistogram(JSON.parse(JSON.stringify(empty)), 'h').right).toEqual(empty);
    });

    it('names every bad field of a malformed histogram under its path', () => {
        const decoded = decodeBoundedHistogram({
            upperBounds: [10, 'x'],
            bucketCounts: [1, 1, 0],
            count: 5,
            sum: 3,
            min: null,
            max: 2
        }, 'figures.histogram');
        const issues = decoded.left ?? [];
        expect(issues.some((issue) => issue.includes('figures.histogram.upperBounds[1]'))).toBe(true);
        expect(issues.some((issue) => issue.includes('figures.histogram.count'))).toBe(true);
        expect(issues.some((issue) => issue.includes('figures.histogram.min'))).toBe(true);

        const emptyWithMin = decodeBoundedHistogram({
            upperBounds: [10],
            bucketCounts: [0, 0],
            count: 0,
            sum: 0,
            min: 1,
            max: null
        }, 'h');
        expect((emptyWithMin.left ?? []).some((issue) => issue.includes('h.min'))).toBe(true);
    });

    it('refuses a value that is not an object, and fractional or negative bucket counts', () => {
        expect(decodeBoundedHistogram(null, 'h').left).toEqual(['h must be an object']);
        const decoded = decodeBoundedHistogram({
            upperBounds: [10],
            bucketCounts: [1.5, -1],
            count: 0.5,
            sum: -1,
            min: 1,
            max: 0
        }, 'h');
        const issues = decoded.left ?? [];
        expect(issues.some((issue) => issue.includes('h.bucketCounts[0]'))).toBe(true);
        expect(issues.some((issue) => issue.includes('h.bucketCounts[1]'))).toBe(true);
        expect(issues.some((issue) => issue.includes('h.sum'))).toBe(true);
    });

    it('refuses a count beyond the safe integers, whose sum of buckets cannot be checked', () => {
        const unsafe = Number.MAX_SAFE_INTEGER + 1;
        const decoded = decodeBoundedHistogram({
            upperBounds: [10],
            bucketCounts: [unsafe, 0],
            count: unsafe,
            sum: 0,
            min: 0,
            max: 0
        }, 'h');

        const issues = decoded.left ?? [];
        expect(issues.some((issue) => issue.includes('h.bucketCounts[0]'))).toBe(true);
        expect(issues.some((issue) => issue.includes('h.count'))).toBe(true);
    });
});
