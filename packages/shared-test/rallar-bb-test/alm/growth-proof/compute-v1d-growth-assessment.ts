import {
    computeDeclaredAppendOnlyAssessment,
    computeDurableAssessment,
    computeRegisteredAssessment,
    computeUnboundedAssessment
} from './compute-v1d-unexpiring-assessment.ts';
import { toV1dGrowthNoData, type V1dGrowthAssessment, type V1dGrowthSeriesInput } from './v1d-growth-assessment.ts';
import {
    computeV1dGrowthAgentBucketMedians,
    computeV1dGrowthMax,
    computeV1dGrowthPlateau,
    computeV1dGrowthSlopePerHour,
    toV1dGrowthLastElapsedMs,
    toV1dGrowthMinutes,
    toV1dGrowthRounded,
    type V1dGrowthAgentReading,
    type V1dGrowthSeriesPoint
} from './v1d-growth-series.ts';
import type { V1dGrowthClassification } from './v1d-growth-surface.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const MB = 1_000_000;
const LAST_WINDOW_MS = 15 * MINUTE_MS;
const MIN_SLOPE_WINDOW_MS = 10 * MINUTE_MS;
const PLATEAU_RELATIVE_TOLERANCE = 0.05;
const PLATEAU_ABSOLUTE_TOLERANCE = 1;
const LINEAR_ACCELERATION_TOLERANCE = 0.5;
/** One row a minute: rows that arrive when sessions close come late and in bursts, at a run rate near zero. */
const LINEAR_ABSOLUTE_TOLERANCE_PER_HOUR = 60;
const HEAP_WARM_UP_MS = 10 * MINUTE_MS;
const HEAP_SLOPE_LIMIT_BYTES_PER_HOUR = 10 * MB;
const HEAP_MAX_PLATEAU_FACTOR = 2;
const PAGE_HEAP_BUCKET_MS = 5 * MINUTE_MS;
const PAGE_HEAP_MIN_BUCKETS = 3;

export function computeV1dGrowthAssessment(
    classification: V1dGrowthClassification,
    input: V1dGrowthSeriesInput
): V1dGrowthAssessment {
    switch (classification.growthClass) {
        case 'count-capped':
            return computeCountCappedAssessment(classification.cap, input.series);
        case 'ttl-within-run':
            return toExpiryHeldAssessment(
                computeTtlWithinRunAssessment(classification.ttlMs, classification.sweepMs, input.series),
                input.neverExpiringSeries
            );
        case 'ttl-beyond-run':
            return toExpiryHeldAssessment(
                computeTtlBeyondRunAssessment(classification.ttlMs, input.series),
                input.neverExpiringSeries
            );
        case 'durable':
            return classification.entityCount.source === 'samples'
                ? computeDurableAssessment(classification, input)
                : computeRegisteredAssessment(classification, classification.entityCount, input);
        case 'declared-append-only':
            return computeDeclaredAppendOnlyAssessment(classification.history, input.series);
        case 'heap':
            return computeHeapAssessment(input.series);
        case 'unbounded':
            return computeUnboundedAssessment(classification.missingBound, input.series);
    }
}

/** A time-to-live bounds only rows that carry one: rows stamped never to expire that rise during the run fail it. */
function toExpiryHeldAssessment(
    assessment: V1dGrowthAssessment,
    neverExpiringSeries: readonly V1dGrowthSeriesPoint[]
): V1dGrowthAssessment {
    const first = neverExpiringSeries[0]?.value ?? 0;
    const max = computeV1dGrowthMax(neverExpiringSeries) ?? first;
    return max <= first || assessment.outcome === 'no-data'
        ? assessment
        : {
            ...assessment,
            outcome: 'fail',
            reason: `rows stamped never to expire rose from ${first} to ${max}; the ttl does not bound them`
        };
}

function computeCountCappedAssessment(cap: number, series: readonly V1dGrowthSeriesPoint[]): V1dGrowthAssessment {
    const bound = `≤ ${cap}`;
    const max = computeV1dGrowthMax(series);
    if (max === null) {
        return toV1dGrowthNoData(bound);
    }
    return {
        bound,
        firstPlateau: computeV1dGrowthPlateau(series, 0),
        slopePerHour: computeV1dGrowthSlopePerHour(series, toV1dGrowthLastElapsedMs(series) - LAST_WINDOW_MS),
        max,
        outcome: max <= cap ? 'pass' : 'fail',
        reason: max <= cap ? `every reading ≤ ${cap}` : `a reading of ${max} exceeds the cap ${cap}`
    };
}

function computeTtlWithinRunAssessment(
    ttlMs: number,
    sweepMs: number,
    series: readonly V1dGrowthSeriesPoint[]
): V1dGrowthAssessment {
    const bound = `ttl ${Math.round(ttlMs / 1_000)} s + sweep ${Math.round(sweepMs / 1_000)} s`;
    const max = computeV1dGrowthMax(series);
    if (max === null) {
        return toV1dGrowthNoData(bound);
    }
    const warmUpMs = ttlMs + sweepMs;
    const lastElapsedMs = toV1dGrowthLastElapsedMs(series);
    const windowStartMs = Math.max(lastElapsedMs - LAST_WINDOW_MS, warmUpMs);
    const firstPlateau = computeV1dGrowthPlateau(series, warmUpMs);
    const slopePerHour = computeV1dGrowthSlopePerHour(series, windowStartMs);
    if (lastElapsedMs - windowStartMs < MIN_SLOPE_WINDOW_MS || slopePerHour === null || firstPlateau === null) {
        return {
            bound,
            firstPlateau,
            slopePerHour,
            max,
            outcome: 'insufficient',
            reason: `the run ends ${toV1dGrowthMinutes(lastElapsedMs)} min in; the plateau needs ` +
                `${toV1dGrowthMinutes(warmUpMs + MIN_SLOPE_WINDOW_MS)} min`
        };
    }
    const lastWindowGrowth = slopePerHour * (LAST_WINDOW_MS / HOUR_MS);
    const tolerance = Math.max(firstPlateau.value * PLATEAU_RELATIVE_TOLERANCE, PLATEAU_ABSOLUTE_TOLERANCE);
    const plateaued = lastWindowGrowth <= tolerance;
    return {
        bound,
        firstPlateau,
        slopePerHour,
        max,
        outcome: plateaued ? 'pass' : 'fail',
        reason: plateaued
            ? `grew ${toV1dGrowthRounded(lastWindowGrowth)} in the last 15 min (tolerance ${
                toV1dGrowthRounded(tolerance)
            })`
            : `still rising after ttl + sweep: ${toV1dGrowthRounded(lastWindowGrowth)} in the last 15 min ` +
                `exceeds ${toV1dGrowthRounded(tolerance)}`
    };
}

/**
 * Rows live out a time-to-live longer than the run, so they may grow at most linearly: the last 15 minutes within
 * 1.5 × the run's rate plus 60 rows an hour. The projection holds the faster of the two rates for one ttl, and never
 * less than the rows already held.
 */
function computeTtlBeyondRunAssessment(ttlMs: number, series: readonly V1dGrowthSeriesPoint[]): V1dGrowthAssessment {
    const toBound = (projected: number) =>
        `ttl ${toHours(ttlMs)} h; projected ≤ ${Math.round(projected)} (max(run, last 15 min) rate × ttl)`;
    const max = computeV1dGrowthMax(series);
    const runRatePerHour = computeV1dGrowthSlopePerHour(series, 0);
    if (max === null || runRatePerHour === null) {
        return toV1dGrowthNoData(toBound(0));
    }
    const lastElapsedMs = toV1dGrowthLastElapsedMs(series);
    const slopePerHour = computeV1dGrowthSlopePerHour(series, lastElapsedMs - LAST_WINDOW_MS);
    const projectedRatePerHour = Math.max(runRatePerHour, slopePerHour ?? 0, 0);
    const projected = Math.max(max, projectedRatePerHour * (ttlMs / HOUR_MS));
    const bound = projected === 0 ? `ttl ${toHours(ttlMs)} h; projected ≤ 0 (no rows held)` : toBound(projected);
    const firstPlateau = computeV1dGrowthPlateau(series, 0);
    if (lastElapsedMs < LAST_WINDOW_MS + MIN_SLOPE_WINDOW_MS || slopePerHour === null) {
        return {
            bound,
            firstPlateau,
            slopePerHour,
            max,
            outcome: 'insufficient',
            reason: `the run ends ${toV1dGrowthMinutes(lastElapsedMs)} min in; a linear check needs ` +
                `${toV1dGrowthMinutes(LAST_WINDOW_MS + MIN_SLOPE_WINDOW_MS)} min`
        };
    }
    const limit = (1 + LINEAR_ACCELERATION_TOLERANCE) * Math.max(runRatePerHour, 0) +
        LINEAR_ABSOLUTE_TOLERANCE_PER_HOUR;
    const linear = slopePerHour <= limit;
    return {
        bound,
        firstPlateau,
        slopePerHour,
        max,
        outcome: linear ? 'pass' : 'fail',
        reason: linear
            ? `grows at most linearly: last 15 min ${toV1dGrowthRounded(slopePerHour)}/h, run ${
                toV1dGrowthRounded(runRatePerHour)
            }/h`
            : `accelerating: last 15 min ${toV1dGrowthRounded(slopePerHour)}/h exceeds ${toV1dGrowthRounded(limit)}/h`
    };
}

function computeHeapAssessment(series: readonly V1dGrowthSeriesPoint[]): V1dGrowthAssessment {
    const bound = `slope within ±${HEAP_SLOPE_LIMIT_BYTES_PER_HOUR / MB} MB/h after ` +
        `${toV1dGrowthMinutes(HEAP_WARM_UP_MS)} min; max < ${HEAP_MAX_PLATEAU_FACTOR} × first plateau`;
    const afterWarmUp = series.filter((point) => point.elapsedMs >= HEAP_WARM_UP_MS);
    const max = computeV1dGrowthMax(afterWarmUp);
    const firstPlateau = computeV1dGrowthPlateau(series, HEAP_WARM_UP_MS);
    const slopePerHour = computeV1dGrowthSlopePerHour(series, HEAP_WARM_UP_MS);
    if (series.length === 0) {
        return toV1dGrowthNoData(bound);
    }
    if (
        max === null || firstPlateau === null || slopePerHour === null ||
        toV1dGrowthLastElapsedMs(series) < HEAP_WARM_UP_MS + MIN_SLOPE_WINDOW_MS
    ) {
        return {
            bound,
            firstPlateau,
            slopePerHour,
            max: computeV1dGrowthMax(series),
            outcome: 'insufficient',
            reason:
                `the run ends ${toV1dGrowthMinutes(toV1dGrowthLastElapsedMs(series))} min in; the heap check needs ` +
                `${toV1dGrowthMinutes(HEAP_WARM_UP_MS + MIN_SLOPE_WINDOW_MS)} min`
        };
    }
    const flat = Math.abs(slopePerHour) <= HEAP_SLOPE_LIMIT_BYTES_PER_HOUR;
    const belowDouble = max < HEAP_MAX_PLATEAU_FACTOR * firstPlateau.value;
    return {
        bound,
        firstPlateau,
        slopePerHour,
        max,
        outcome: flat && belowDouble ? 'pass' : 'fail',
        reason: `slope ${toV1dGrowthRounded(slopePerHour / MB)} MB/h${flat ? '' : ' exceeds the limit'}; ` +
            `max ${toV1dGrowthRounded(max / MB)} MB against the first plateau ` +
            `${toV1dGrowthRounded(firstPlateau.value / MB)} MB` +
            `${belowDouble ? '' : ', twice it or more'}`
    };
}

/**
 * A `heap` surface's browser page heap. It is read without a forced collection, so its GC sawtooth swings by more
 * than the heap's own growth: the slope and the plateau factor read 5-minute bucket medians after the warm-up, and
 * the raw peak is only reported.
 */
export function computePageHeapAssessment(readings: readonly V1dGrowthAgentReading[]): V1dGrowthAssessment {
    const bound = `5-minute bucket medians after ${toV1dGrowthMinutes(HEAP_WARM_UP_MS)} min: slope within ` +
        `±${HEAP_SLOPE_LIMIT_BYTES_PER_HOUR / MB} MB/h; last < ${HEAP_MAX_PLATEAU_FACTOR} × first`;
    if (readings.length === 0) {
        return toV1dGrowthNoData(bound);
    }
    const afterWarmUp = readings.filter((reading) => reading.elapsedMs >= HEAP_WARM_UP_MS);
    const medians = computeV1dGrowthAgentBucketMedians(afterWarmUp, PAGE_HEAP_BUCKET_MS);
    const max = computeV1dGrowthMax(afterWarmUp);
    const first = medians[0];
    const last = medians[medians.length - 1];
    const slopePerHour = computeV1dGrowthSlopePerHour(medians, 0);
    if (medians.length < PAGE_HEAP_MIN_BUCKETS || first === undefined || last === undefined || slopePerHour === null) {
        return {
            bound,
            firstPlateau: first === undefined ? null : { atElapsedMs: first.elapsedMs, value: first.value },
            slopePerHour,
            max,
            outcome: 'insufficient',
            reason: `${medians.length} complete 5-minute buckets after the warm-up; the page heap check needs ` +
                `${PAGE_HEAP_MIN_BUCKETS} complete 5-minute buckets`
        };
    }
    const flat = Math.abs(slopePerHour) <= HEAP_SLOPE_LIMIT_BYTES_PER_HOUR;
    const belowDouble = last.value < HEAP_MAX_PLATEAU_FACTOR * first.value;
    return {
        bound,
        firstPlateau: { atElapsedMs: first.elapsedMs, value: first.value },
        slopePerHour,
        max,
        outcome: flat && belowDouble ? 'pass' : 'fail',
        reason:
            `bucket median slope ${toV1dGrowthRounded(slopePerHour / MB)} MB/h${flat ? '' : ' exceeds the limit'}; ` +
            `last bucket median ${toV1dGrowthRounded(last.value / MB)} MB against the first ` +
            `${toV1dGrowthRounded(first.value / MB)} MB${belowDouble ? '' : ', twice it or more'}; ` +
            `raw peak ${toV1dGrowthRounded((max ?? 0) / MB)} MB, not judged`
    };
}

function toHours(milliseconds: number): number {
    return Math.round((milliseconds / HOUR_MS) * 10) / 10;
}
