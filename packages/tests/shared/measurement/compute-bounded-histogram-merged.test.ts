import { describe, expect, it } from 'vitest';

import {
    computeBoundedHistogramRecorded,
    createBoundedHistogram,
    decodeBoundedHistogram,
    type BoundedHistogram
} from '@shared/measurement/bounded-histogram.ts';
import { computeBoundedHistogramMerged } from '@shared/measurement/compute-bounded-histogram-merged.ts';
import { computeBoundedHistogramQuantile } from '@shared/measurement/compute-bounded-histogram-quantile.ts';

/** On the bounds 10 and 100: the samples 3 and 40, one up to 10 and one up to 100. */
const SAMPLES_3_AND_40: BoundedHistogram = {
    upperBounds: [10, 100],
    bucketCounts: [1, 1, 0],
    count: 2,
    sum: 43,
    min: 3,
    max: 40
};

/** On the same bounds: the samples 7 and 250, one up to 10 and one above the last bound. */
const SAMPLES_7_AND_250: BoundedHistogram = {
    upperBounds: [10, 100],
    bucketCounts: [1, 0, 1],
    count: 2,
    sum: 257,
    min: 7,
    max: 250
};

const NO_SAMPLE: BoundedHistogram = {
    upperBounds: [10, 100],
    bucketCounts: [0, 0, 0],
    count: 0,
    sum: 0,
    min: null,
    max: null
};

interface OtherBounds {
    readonly other: string;
    readonly left: readonly number[];
    readonly right: readonly number[];
}

const OTHER_BOUNDS: readonly OtherBounds[] = [
    { other: 'one bound that differs', left: [10, 100], right: [10, 200] },
    { other: 'one bound more on the right', left: [10, 100], right: [10, 100, 1000] },
    { other: 'one bound more on the left', left: [10, 100, 1000], right: [10, 100] }
];

describe('computeBoundedHistogramMerged', () => {
    it('merges two histograms on the same bounds into the histogram of both sample lists', () => {
        const merged = computeBoundedHistogramMerged(SAMPLES_3_AND_40, SAMPLES_7_AND_250);

        // 3 and 7 up to 10, 40 up to 100, 250 above it; 3 + 40 + 7 + 250 = 300.
        expect(merged.right).toEqual({
            upperBounds: [10, 100],
            bucketCounts: [2, 1, 1],
            count: 4,
            sum: 300,
            min: 3,
            max: 250
        });
        // Rank 2 of 4 is 7, in the first bucket, which starts at the smallest sample.
        expect(computeBoundedHistogramQuantile(merged.right!, 0.5)).toEqual({ atLeast: 3, atMost: 10 });
    });

    it('equals recording every sample into one histogram, for whole-millisecond samples', () => {
        const empty = createBoundedHistogram([1, 2, 5, 10, 20, 50, 100]).right!;
        const first = [0, 1, 4, 4, 18, 37, 100, 640];
        const second = [2, 3, 9, 51, 12, 2_000, 5];

        const merged = computeBoundedHistogramMerged(
            computeBoundedHistogramRecorded(empty, first).histogram,
            computeBoundedHistogramRecorded(empty, second).histogram
        );

        expect(merged.right).toEqual(computeBoundedHistogramRecorded(empty, [...first, ...second]).histogram);
    });

    it('returns the other histogram when one holds no sample, in either order', () => {
        expect(computeBoundedHistogramMerged(NO_SAMPLE, SAMPLES_7_AND_250).right).toEqual(SAMPLES_7_AND_250);
        expect(computeBoundedHistogramMerged(SAMPLES_7_AND_250, NO_SAMPLE).right).toEqual(SAMPLES_7_AND_250);
        expect(computeBoundedHistogramMerged(NO_SAMPLE, NO_SAMPLE).right).toEqual(NO_SAMPLE);
    });

    it.each(OTHER_BOUNDS)('refuses histograms on other bounds: $other', ({ left, right }) => {
        const merged = computeBoundedHistogramMerged(
            createBoundedHistogram(left).right!,
            createBoundedHistogram(right).right!
        );

        expect(merged.right).toBeUndefined();
        expect(merged.left).toEqual(expect.any(String));
    });

    it('its result passes decodeBoundedHistogram', () => {
        // The left holds the largest sample and the right the smallest, each in a bucket the other counts nothing in.
        const samples40And250: BoundedHistogram = {
            upperBounds: [10, 100],
            bucketCounts: [0, 1, 1],
            count: 2,
            sum: 290,
            min: 40,
            max: 250
        };
        const samples3And7: BoundedHistogram = {
            upperBounds: [10, 100],
            bucketCounts: [2, 0, 0],
            count: 2,
            sum: 10,
            min: 3,
            max: 7
        };

        const merged = computeBoundedHistogramMerged(samples40And250, samples3And7).right!;

        const decoded = decodeBoundedHistogram(JSON.parse(JSON.stringify(merged)), 'merged');
        expect(decoded.left).toBeUndefined();
        expect(decoded.right).toEqual({
            upperBounds: [10, 100],
            bucketCounts: [2, 1, 1],
            count: 4,
            sum: 300,
            min: 3,
            max: 250
        });
    });
});
