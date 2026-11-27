import { describe, expect, it } from 'vitest';

import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import {
    computeBoundedHistogramAfter,
    computeBoundedHistogramRecorded,
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

interface DecodedExtremes {
    readonly bucketCounts: readonly number[];
    readonly min: number;
    readonly max: number;
}

interface RefusedExtremes extends DecodedExtremes {
    readonly refused: string;
    readonly fields: readonly string[];
}

interface AcceptedExtremes extends DecodedExtremes {
    readonly accepted: string;
}

/**
 * On the bounds 10 and 100 a recorded sample of 0 to 10 is counted in the first bucket, one above 10 and up to 100 in
 * the second, and one above 100 in the overflow bucket.
 */
const EXTREMES_OUTSIDE_THEIR_BUCKETS: readonly RefusedExtremes[] = [
    {
        refused: 'a min and a max above the only bucket that counts a sample',
        bucketCounts: [3, 0, 0],
        min: 500,
        max: 500,
        fields: ['h.min', 'h.max']
    },
    {
        refused: 'a min above the bound of the first bucket that counts a sample',
        bucketCounts: [1, 1, 0],
        min: 11,
        max: 50,
        fields: ['h.min']
    },
    {
        refused: 'a min on the bound under the first bucket that counts a sample',
        bucketCounts: [0, 2, 0],
        min: 10,
        max: 50,
        fields: ['h.min']
    },
    {
        refused: 'a max above the bound of the last bucket that counts a sample',
        bucketCounts: [1, 1, 0],
        min: 5,
        max: 101,
        fields: ['h.max']
    },
    {
        refused: 'a max on the bound under the overflow bucket, the last that counts a sample',
        bucketCounts: [1, 0, 1],
        min: 5,
        max: 100,
        fields: ['h.max']
    },
    { refused: 'a negative min', bucketCounts: [1, 1, 0], min: -1, max: 50, fields: ['h.min'] }
];

const EXTREMES_ON_THE_EDGES_OF_THEIR_BUCKETS: readonly AcceptedExtremes[] = [
    { accepted: 'a min and a max each exactly on the bound of its bucket', bucketCounts: [1, 1, 0], min: 10, max: 100 },
    { accepted: 'a min of 0 in the first bucket', bucketCounts: [2, 0, 0], min: 0, max: 0 },
    { accepted: 'a min just above the last bound and any larger max', bucketCounts: [0, 0, 2], min: 100.5, max: 1e9 }
];

/** A histogram on the bounds 10 and 100 whose count is the sum of its buckets; the sum is not read against the extremes. */
function toDecodedExtremes(bucketCounts: readonly number[], min: number, max: number): ApiJsonObject {
    const count = bucketCounts.reduce((total, each) => total + each, 0);
    return { upperBounds: [10, 100], bucketCounts, count, sum: count, min, max };
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

    it('records a list of values onto what a histogram already holds, and counts each refused value instead', () => {
        const before = createRecorded([10, 100], [7]);

        const recorded = computeBoundedHistogramRecorded(before, [5, -1, 50, Number.NaN, 500]);

        expect(recorded).toEqual({
            histogram: { upperBounds: [10, 100], bucketCounts: [2, 1, 1], count: 4, sum: 562, min: 5, max: 500 },
            unrecordedSamples: 2
        });
        expect(before.count).toBe(1);
        expect(computeBoundedHistogramRecorded(before, [])).toEqual({ histogram: before, unrecordedSamples: 0 });
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

    it.each(EXTREMES_OUTSIDE_THEIR_BUCKETS)(
        'refuses $refused, naming $fields',
        ({ bucketCounts, min, max, fields }) => {
            const decoded = decodeBoundedHistogram(toDecodedExtremes(bucketCounts, min, max), 'h');

            expect(decoded.right).toBeUndefined();
            expect(decoded.left?.map((issue) => issue.slice(0, issue.indexOf(' ')))).toEqual(fields);
        }
    );

    it.each(EXTREMES_ON_THE_EDGES_OF_THEIR_BUCKETS)('decodes $accepted', ({ bucketCounts, min, max }) => {
        expect(decodeBoundedHistogram(toDecodedExtremes(bucketCounts, min, max), 'h').right)
            .toMatchObject({ bucketCounts, min, max });
    });

    it('decodes every histogram that recording produced, whichever buckets its smallest and largest sample fell in', () => {
        // On the bounds 10 and 100: 0 and 10 close the first bucket, 10.5 and 100 the second, 100.5 and 2500 overflow.
        const samples = [0, 10, 10.5, 100, 100.5, 2500];
        for (let start = 0; start < samples.length; start += 1) {
            for (let end = start + 1; end <= samples.length; end += 1) {
                const recorded = createRecorded([10, 100], samples.slice(start, end));

                expect(decodeBoundedHistogram(JSON.parse(JSON.stringify(recorded)), 'h').right).toEqual(recorded);
            }
        }
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
