import { describe, expect, it } from 'vitest';

import {
    computeBoundedHistogramRecorded,
    createBoundedHistogram,
    type BoundedHistogram
} from '@shared/measurement/bounded-histogram.ts';
import {
    computeBoundedHistogramQuantile,
    type BoundedHistogramQuantile
} from '@shared/measurement/compute-bounded-histogram-quantile.ts';
import { computeNearestRank } from '@shared/measurement/compute-nearest-rank.ts';

function createRecorded(upperBounds: readonly number[], values: readonly number[]): BoundedHistogram {
    return computeBoundedHistogramRecorded(createBoundedHistogram(upperBounds).right!, values).histogram;
}

/**
 * Twenty samples on the bounds 10, 100 and 1000. Ascending: 1, 3, 4, 7, 9, 10 (six up to 10), 12, 15, 30, 42, 55, 60,
 * 70, 99, 100 (nine up to 100), 150, 400, 900, 950 (four up to 1000) and 2500 (one above the last bound).
 */
// dprint-ignore
const SAMPLES: readonly number[] = [42, 1, 900, 10, 70, 2500, 3, 150, 12, 99, 4, 55, 950, 7, 100, 15, 400, 9, 60, 30];

interface RankedBucket {
    readonly fraction: number;
    readonly bucket: BoundedHistogramQuantile;
}

/**
 * Rank 6 is 10, the last sample of the first bucket, which starts at the smallest sample, 1. Rank 10 is 42 and rank 15
 * is 100, the last sample of the second bucket. Rank 19 is 950 and rank 20 is 2500, in the third and the overflow bucket.
 */
const RANKED_BUCKETS: readonly RankedBucket[] = [
    { fraction: 0.3, bucket: { atLeast: 1, atMost: 10 } },
    { fraction: 0.5, bucket: { atLeast: 10, atMost: 100 } },
    { fraction: 0.75, bucket: { atLeast: 10, atMost: 100 } },
    { fraction: 0.95, bucket: { atLeast: 100, atMost: 1000 } },
    { fraction: 0.99, bucket: { atLeast: 1000, atMost: 2500 } }
];

describe('computeBoundedHistogramQuantile', () => {
    it.each(RANKED_BUCKETS)(
        'reads at $fraction the bucket that holds the nearest-rank sample of the raw values',
        ({ fraction, bucket }) => {
            const quantile = computeBoundedHistogramQuantile(createRecorded([10, 100, 1000], SAMPLES), fraction);

            expect(quantile).toEqual(bucket);
            const ranked = computeNearestRank(SAMPLES, fraction)!;
            expect(quantile!.atLeast).toBeLessThanOrEqual(ranked);
            expect(quantile!.atMost).toBeGreaterThanOrEqual(ranked);
        }
    );

    it('has no answer for a histogram that holds no sample', () => {
        expect(computeBoundedHistogramQuantile(createRecorded([10, 100, 1000], []), 0.5)).toBeUndefined();
    });

    it('narrows the bucket to the smallest and the largest sample, so a single sample reads as itself', () => {
        expect(computeBoundedHistogramQuantile(createRecorded([10, 100], [20, 30, 40]), 0.5))
            .toEqual({ atLeast: 20, atMost: 40 });
        for (const fraction of [0, 0.5, 0.99, 1]) {
            expect(computeBoundedHistogramQuantile(createRecorded([10, 100], [42]), fraction))
                .toEqual({ atLeast: 42, atMost: 42 });
        }
    });

    it('starts the first bucket at the smallest sample and ends the overflow bucket at the largest', () => {
        const histogram = createRecorded([10, 100], [7, 4000, 3, 2500]);

        expect(computeBoundedHistogramQuantile(histogram, 0.25)).toEqual({ atLeast: 3, atMost: 10 });
        expect(computeBoundedHistogramQuantile(histogram, 0.75)).toEqual({ atLeast: 100, atMost: 4000 });
    });

    it('reads a sample exactly on a bound in the bucket that bound closes', () => {
        const histogram = createRecorded([10, 100], [5, 10, 50]);

        expect(computeBoundedHistogramQuantile(histogram, 0.5)).toEqual({ atLeast: 5, atMost: 10 });
    });

    it('reads the smallest sample at or below fraction 0 and the largest at or above 1', () => {
        const histogram = createRecorded([10, 100, 1000], SAMPLES);

        for (const fraction of [0, -0.5]) {
            expect(computeBoundedHistogramQuantile(histogram, fraction)).toEqual({ atLeast: 1, atMost: 10 });
        }
        for (const fraction of [1, 1.5]) {
            expect(computeBoundedHistogramQuantile(histogram, fraction)).toEqual({ atLeast: 1000, atMost: 2500 });
        }
    });

    it('throws for a histogram whose buckets count fewer samples than its count, a programmer\'s error', () => {
        const miscounted: BoundedHistogram = {
            upperBounds: [10],
            bucketCounts: [1, 0],
            count: 3,
            sum: 15,
            min: 5,
            max: 5
        };

        expect(() => computeBoundedHistogramQuantile(miscounted, 1)).toThrow();
    });

    it('has no answer for a fraction that is not a finite number', () => {
        const histogram = createRecorded([10, 100, 1000], SAMPLES);

        for (const fraction of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
            expect(computeBoundedHistogramQuantile(histogram, fraction)).toBeUndefined();
        }
    });
});
