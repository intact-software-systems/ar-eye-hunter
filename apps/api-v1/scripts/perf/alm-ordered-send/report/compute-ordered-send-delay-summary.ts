import { assertBoundedHistogram } from '@shared/measurement/assert-bounded-histogram.ts';
import {
    computeBoundedHistogramAfter,
    computeBoundedHistogramRecorded,
    type BoundedHistogram
} from '@shared/measurement/bounded-histogram.ts';
import { computeNearestRank } from '@shared/measurement/compute-nearest-rank.ts';

/**
 * One delay figure of the report, in milliseconds. Its samples are the delays of at least 0; a delay below 0, the
 * later instant read before the earlier one, is in `unrecordedSamples` and in no other figure here.
 */
export interface OrderedSendDelaySummary {
    readonly count: number;
    /** The percentiles are nearest ranks; they and `max` are null over no samples. */
    readonly p50: number | null;
    readonly p95: number | null;
    readonly p99: number | null;
    readonly max: number | null;
    readonly histogram: BoundedHistogram;
    readonly unrecordedSamples: number;
}

const ORDERED_SEND_DELAY_BOUNDS_MS: readonly number[] = [
    1,
    2,
    5,
    10,
    20,
    50,
    100,
    200,
    500,
    1_000,
    2_000,
    5_000,
    10_000,
    20_000,
    30_000,
    60_000
];

const NO_ORDERED_SEND_DELAYS = assertBoundedHistogram(ORDERED_SEND_DELAY_BOUNDS_MS, 'ORDERED_SEND_DELAY_BOUNDS_MS');

export function computeOrderedSendDelaySummary(delaysMs: readonly number[]): OrderedSendDelaySummary {
    const recorded = computeBoundedHistogramRecorded(NO_ORDERED_SEND_DELAYS, delaysMs);
    const samplesMs = delaysMs.filter(isOrderedSendDelaySample);
    return {
        count: recorded.histogram.count,
        p50: computeNearestRank(samplesMs, 0.5) ?? null,
        p95: computeNearestRank(samplesMs, 0.95) ?? null,
        p99: computeNearestRank(samplesMs, 0.99) ?? null,
        max: recorded.histogram.max,
        histogram: recorded.histogram,
        unrecordedSamples: recorded.unrecordedSamples
    };
}

/** The histogram's own answer, so a percentile and a bucket never cover different delays. */
export function isOrderedSendDelaySample(delayMs: number): boolean {
    return computeBoundedHistogramAfter(NO_ORDERED_SEND_DELAYS, delayMs).right !== undefined;
}
