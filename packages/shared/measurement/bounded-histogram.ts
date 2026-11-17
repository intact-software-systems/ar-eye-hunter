import { isApiJsonObject, type ApiJsonObject } from '../api/api-json-value.ts';
import { Either } from '../resilience/Either.ts';

export interface BoundedHistogram {
    readonly upperBounds: readonly number[];
    readonly bucketCounts: readonly number[];
    readonly count: number;
    readonly sum: number;
    readonly min: number | null;
    readonly max: number | null;
}

export const MAX_BOUNDED_HISTOGRAM_BOUNDS = 32;

function isFiniteNonNegative(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isWholeCount(value: unknown): value is number {
    return isFiniteNonNegative(value) && Number.isSafeInteger(value);
}

function decodeBoundedHistogramBounds(value: unknown, path: string): Either<readonly string[], readonly number[]> {
    if (!Array.isArray(value)) {
        return Either.ofLeft([`${path} must be an array`]);
    }
    const issues: string[] = [];
    if (value.length === 0 || value.length > MAX_BOUNDED_HISTOGRAM_BOUNDS) {
        issues.push(`${path} must hold 1 to ${MAX_BOUNDED_HISTOGRAM_BOUNDS} bounds`);
    }
    value.forEach((bound, index) => {
        if (!isFiniteNonNegative(bound)) {
            issues.push(`${path}[${index}] must be a finite number of at least 0`);
        }
        else if (index > 0 && !(bound > value[index - 1])) {
            issues.push(`${path}[${index}] must be greater than the bound before it`);
        }
    });
    return issues.length > 0 ? Either.ofLeft(issues) : Either.ofRight([...value] as number[]);
}

export function createBoundedHistogram(upperBounds: readonly number[]): Either<string, BoundedHistogram> {
    const bounds = decodeBoundedHistogramBounds(upperBounds, 'upperBounds');
    if (bounds.left !== undefined) {
        return Either.ofLeft(bounds.left.join('; '));
    }
    return Either.ofRight({
        upperBounds: bounds.right!,
        bucketCounts: new Array<number>(upperBounds.length + 1).fill(0),
        count: 0,
        sum: 0,
        min: null,
        max: null
    });
}

export function computeBoundedHistogramAfter(
    histogram: BoundedHistogram,
    value: number
): Either<string, BoundedHistogram> {
    if (!isFiniteNonNegative(value)) {
        return Either.ofLeft('A histogram records only a finite number of at least 0');
    }
    const found = histogram.upperBounds.findIndex((bound) => value <= bound);
    const bucket = found === -1 ? histogram.upperBounds.length : found;
    return Either.ofRight({
        upperBounds: histogram.upperBounds,
        bucketCounts: histogram.bucketCounts.map((count, index) => index === bucket ? count + 1 : count),
        count: histogram.count + 1,
        sum: histogram.sum + value,
        min: histogram.min === null ? value : Math.min(histogram.min, value),
        max: histogram.max === null ? value : Math.max(histogram.max, value)
    });
}

function validateBoundedHistogramBuckets(record: ApiJsonObject, path: string): string[] {
    const { bucketCounts, upperBounds, count } = record;
    if (!Array.isArray(bucketCounts)) {
        return [`${path}.bucketCounts must be an array`];
    }
    const issues: string[] = [];
    if (Array.isArray(upperBounds) && bucketCounts.length !== upperBounds.length + 1) {
        issues.push(`${path}.bucketCounts must hold one more count than ${path}.upperBounds holds bounds`);
    }
    bucketCounts.forEach((bucketCount, index) => {
        if (!isWholeCount(bucketCount)) {
            issues.push(`${path}.bucketCounts[${index}] must be a whole number of at least 0`);
        }
    });
    if (!isWholeCount(count)) {
        issues.push(`${path}.count must be a whole number of at least 0`);
    }
    else if (bucketCounts.every(isWholeCount) && bucketCounts.reduce((total, each) => total + each, 0) !== count) {
        issues.push(`${path}.count must equal the sum of ${path}.bucketCounts`);
    }
    return issues;
}

function validateBoundedHistogramExtremes(record: ApiJsonObject, path: string): string[] {
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
        if (typeof extreme !== 'number' || !Number.isFinite(extreme)) {
            issues.push(`${path}.${name} must be a finite number when ${path}.count is above 0`);
        }
    }
    if (typeof min === 'number' && typeof max === 'number' && min > max) {
        issues.push(`${path}.min must not be above ${path}.max`);
    }
    return issues;
}

export function decodeBoundedHistogram(value: unknown, path: string): Either<readonly string[], BoundedHistogram> {
    if (!isApiJsonObject(value)) {
        return Either.ofLeft([`${path} must be an object`]);
    }
    const upperBounds = decodeBoundedHistogramBounds(value.upperBounds, `${path}.upperBounds`);
    const issues = [
        ...(upperBounds.left ?? []),
        ...validateBoundedHistogramBuckets(value, path),
        ...validateBoundedHistogramExtremes(value, path)
    ];
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    return Either.ofRight({
        upperBounds: upperBounds.right!,
        bucketCounts: [...(value.bucketCounts as number[])],
        count: value.count as number,
        sum: value.sum as number,
        min: value.min as number | null,
        max: value.max as number | null
    });
}

export function decodeBoundedHistogramOnBounds(
    value: unknown,
    path: string,
    declaredBounds: readonly number[]
): Either<readonly string[], BoundedHistogram> {
    const histogram = decodeBoundedHistogram(value, path);
    if (histogram.right === undefined) {
        return histogram;
    }
    const { upperBounds } = histogram.right;
    return upperBounds.length === declaredBounds.length &&
            upperBounds.every((bound, index) => bound === declaredBounds[index])
        ? histogram
        : Either.ofLeft([`${path}.upperBounds are not the bounds declared for it`]);
}
