import type { ApiJsonObject } from '../api/api-json-value.ts';
import { isFiniteNonNegative, isWholeCount } from './bounded-histogram-number-guards.ts';

/**
 * Every issue in the sum and the extremes of a histogram read from outside. `upperBounds` are its bounds as their
 * owner decoded them, absent where they did not decode: no extreme is then placed in a bucket.
 */
export function validateBoundedHistogramExtremes(
    record: ApiJsonObject,
    path: string,
    upperBounds: readonly number[] | undefined
): string[] {
    const { count, min, max, sum } = record;
    const issues: string[] = [];
    if (!isFiniteNonNegative(sum)) {
        issues.push(`${path}.sum must be a finite number of at least 0`);
    }
    if (count === 0) {
        for (const [name, extreme] of [['min', min], ['max', max]] as const) {
            if (extreme !== null) {
                issues.push(`${path}.${name} must be null when ${path}.count is 0`);
            }
        }
        return issues;
    }
    for (const [name, extreme] of [['min', min], ['max', max]] as const) {
        if (!isFiniteNonNegative(extreme)) {
            issues.push(`${path}.${name} must be a finite number of at least 0 when ${path}.count is above 0`);
        }
    }
    if (typeof min === 'number' && typeof max === 'number' && min > max) {
        issues.push(`${path}.min must not be above ${path}.max`);
    }
    return upperBounds === undefined
        ? issues
        : [...issues, ...validateBoundedHistogramExtremeBuckets(record, path, upperBounds)];
}

/**
 * Recording counts a sample in the first bucket whose bound it does not exceed, so the smallest sample lies in the
 * first bucket that counts one and the largest in the last. Read only where the bounds and the counts hold their own
 * rules, and for an extreme that is itself a sample a histogram records.
 */
function validateBoundedHistogramExtremeBuckets(
    record: ApiJsonObject,
    path: string,
    upperBounds: readonly number[]
): string[] {
    const { bucketCounts, min, max } = record;
    if (
        !Array.isArray(bucketCounts) || bucketCounts.length !== upperBounds.length + 1 ||
        !bucketCounts.every(isWholeCount)
    ) {
        return [];
    }
    const first = bucketCounts.findIndex((bucketCount) => bucketCount > 0);
    const last = bucketCounts.findLastIndex((bucketCount) => bucketCount > 0);
    const issues: string[] = [];
    for (const [name, extreme, bucket, place] of [['min', min, first, 'first'], ['max', max, last, 'last']] as const) {
        if (
            bucket !== -1 && isFiniteNonNegative(extreme) && !isInBoundedHistogramBucket(extreme, upperBounds, bucket)
        ) {
            issues.push(
                `${path}.${name} must be ${toBoundedHistogramBucketRange(upperBounds, bucket)}: ` +
                    `${path}.bucketCounts[${bucket}] is the ${place} bucket that counts a sample`
            );
        }
    }
    return issues;
}

/** A sample of at least 0 is in a bucket when it is above the bound before it and at most the bucket's own bound. */
function isInBoundedHistogramBucket(sample: number, upperBounds: readonly number[], bucket: number): boolean {
    return (bucket === 0 || sample > upperBounds[bucket - 1]) &&
        (bucket === upperBounds.length || sample <= upperBounds[bucket]);
}

function toBoundedHistogramBucketRange(upperBounds: readonly number[], bucket: number): string {
    const above = bucket === 0 ? 'at least 0' : `above ${upperBounds[bucket - 1]}`;
    return bucket === upperBounds.length ? above : `${above} and at most ${upperBounds[bucket]}`;
}
