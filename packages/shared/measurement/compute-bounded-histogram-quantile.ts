import type { BoundedHistogram } from './bounded-histogram.ts';
import { computeNearestRankIndex } from './compute-nearest-rank.ts';

/**
 * The range a ranked sample lies in: the sample is at least `atLeast` and at most `atMost`; where `atLeast` is a
 * bucket's lower bound the sample is above it.
 */
export interface BoundedHistogramQuantile {
    readonly atLeast: number;
    readonly atMost: number;
}

/**
 * A histogram keeps no sample, so its quantile is the bucket that holds the sample at the rank `computeNearestRank`
 * reads, narrowed by `min` and `max`. `atLeast` is the bound under that bucket, which the sample itself exceeds, or
 * `min` where that is higher: the first bucket, whose floor is 0, starts at `min`. `atMost` is the bucket's own bound,
 * or `max` where that is lower: the overflow bucket, which has no bound, ends at `max`. A histogram with no sample,
 * or a fraction that is not finite, has no answer.
 */
export function computeBoundedHistogramQuantile(
    histogram: BoundedHistogram,
    fraction: number
): BoundedHistogramQuantile | undefined {
    const { upperBounds, min, max } = histogram;
    const rankIndex = computeNearestRankIndex(histogram.count, fraction);
    if (rankIndex === undefined || min === null || max === null) {
        return undefined;
    }
    const bucket = resolveRankedBucket(histogram.bucketCounts, rankIndex);
    return {
        atLeast: bucket === 0 ? min : Math.max(upperBounds[bucket - 1], min),
        atMost: bucket === upperBounds.length ? max : Math.min(upperBounds[bucket], max)
    };
}

function resolveRankedBucket(bucketCounts: readonly number[], rankIndex: number): number {
    let samplesThroughBucket = 0;
    for (let bucket = 0; bucket < bucketCounts.length; bucket += 1) {
        samplesThroughBucket += bucketCounts[bucket];
        if (rankIndex < samplesThroughBucket) {
            return bucket;
        }
    }
    throw new Error('A bounded histogram counts every sample in one of its buckets.');
}
