import {
    computeDeclaredAppendOnlyAssessment,
    computeDurableAssessment,
    computeRegisteredAssessment,
    computeUnboundedAssessment
} from './compute-v1d-unexpiring-assessment.ts';
import { toV1dGrowthNoData, type V1dGrowthAssessment, type V1dGrowthSeriesInput } from './v1d-growth-assessment.ts';
import {
    computeV1dGrowthMax,
    computeV1dGrowthPlateau,
    computeV1dGrowthSlopePerHour,
    toV1dGrowthLastElapsedMs,
    toV1dGrowthMinutes,
    toV1dGrowthRounded,
    type V1dGrowthSeriesPoint
} from './v1d-growth-series.ts';
import type { V1dGrowthCap, V1dGrowthClassification } from './v1d-growth-surface.ts';
import type { V1dGrowthWorkload } from './v1d-growth-workload.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
export const MB = 1_000_000;
const LAST_WINDOW_MS = 15 * MINUTE_MS;
const MIN_SLOPE_WINDOW_MS = 10 * MINUTE_MS;
const PLATEAU_RELATIVE_TOLERANCE = 0.05;
const PLATEAU_ABSOLUTE_TOLERANCE = 1;
const LINEAR_ACCELERATION_TOLERANCE = 0.5;
/** One row a minute: rows that arrive when sessions close come late and in bursts, at a run rate near zero. */
const LINEAR_ABSOLUTE_TOLERANCE_PER_HOUR = 60;
export const HEAP_WARM_UP_MS = 10 * MINUTE_MS;
export const HEAP_SLOPE_LIMIT_BYTES_PER_HOUR = 10 * MB;
export const HEAP_MAX_PLATEAU_FACTOR = 2;

export function computeV1dGrowthAssessment(
    classification: V1dGrowthClassification,
    input: V1dGrowthSeriesInput
): V1dGrowthAssessment {
    switch (classification.growthClass) {
        case 'count-capped':
            return computeCountCappedAssessment(resolveV1dGrowthCap(classification.cap, input.workload), input.series);
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

/** Null where the cap is the workload's and the run recorded none. */
function resolveV1dGrowthCap(cap: V1dGrowthCap, workload: V1dGrowthWorkload | null): number | null {
    if (typeof cap === 'number') {
        return cap;
    }
    return workload === null ? null : workload.eventHistoryMaxEvents;
}

function computeCountCappedAssessment(
    cap: number | null,
    series: readonly V1dGrowthSeriesPoint[]
): V1dGrowthAssessment {
    const bound = `≤ ${cap ?? 'unrecorded'}`;
    const max = computeV1dGrowthMax(series);
    if (max === null || cap === null) {
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

function toHours(milliseconds: number): number {
    return Math.round((milliseconds / HOUR_MS) * 10) / 10;
}
