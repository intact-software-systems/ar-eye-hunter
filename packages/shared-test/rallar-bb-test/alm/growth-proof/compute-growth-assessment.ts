import {
    computeDeclaredAppendOnlyAssessment,
    computeDurableAssessment,
    computeRegisteredAssessment,
    computeUnboundedAssessment
} from './compute-growth-unexpiring-assessment.ts';
import { toGrowthNoData, type GrowthAssessment, type GrowthSeriesInput } from './growth-assessment.ts';
import {
    computeGrowthMax,
    computeGrowthPlateau,
    computeGrowthSlopePerHour,
    toGrowthLastElapsedMs,
    toGrowthMinutes,
    toGrowthRounded,
    type GrowthSeriesPoint
} from './growth-series.ts';
import type { GrowthCap, GrowthClassification } from './growth-surface.ts';
import type { GrowthWorkload } from './growth-workload.ts';

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

export function computeGrowthAssessment(
    classification: GrowthClassification,
    input: GrowthSeriesInput
): GrowthAssessment {
    switch (classification.growthClass) {
        case 'count-capped':
            return computeCountCappedAssessment(resolveGrowthCap(classification.cap, input.workload), input.series);
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
    assessment: GrowthAssessment,
    neverExpiringSeries: readonly GrowthSeriesPoint[]
): GrowthAssessment {
    const first = neverExpiringSeries[0]?.value ?? 0;
    const max = computeGrowthMax(neverExpiringSeries) ?? first;
    return max <= first || assessment.outcome === 'no-data'
        ? assessment
        : {
            ...assessment,
            outcome: 'fail',
            reason: `rows stamped never to expire rose from ${first} to ${max}; the ttl does not bound them`
        };
}

/** Null where the cap is the workload's and the run recorded none. */
function resolveGrowthCap(cap: GrowthCap, workload: GrowthWorkload | null): number | null {
    if (typeof cap === 'number') {
        return cap;
    }
    if (workload === null) {
        return null;
    }
    return cap.source === 'workload-event-history'
        ? workload.eventHistoryMaxEvents
        : workload.groupCurrentSnapshotCacheMaxEntries;
}

function computeCountCappedAssessment(
    cap: number | null,
    series: readonly GrowthSeriesPoint[]
): GrowthAssessment {
    const bound = `≤ ${cap ?? 'unrecorded'}`;
    const max = computeGrowthMax(series);
    if (max === null || cap === null) {
        return toGrowthNoData(bound);
    }
    return {
        bound,
        firstPlateau: computeGrowthPlateau(series, 0),
        slopePerHour: computeGrowthSlopePerHour(series, toGrowthLastElapsedMs(series) - LAST_WINDOW_MS),
        max,
        outcome: max <= cap ? 'pass' : 'fail',
        reason: max <= cap ? `every reading ≤ ${cap}` : `a reading of ${max} exceeds the cap ${cap}`
    };
}

function computeTtlWithinRunAssessment(
    ttlMs: number,
    sweepMs: number,
    series: readonly GrowthSeriesPoint[]
): GrowthAssessment {
    const bound = `ttl ${Math.round(ttlMs / 1_000)} s + sweep ${Math.round(sweepMs / 1_000)} s`;
    const max = computeGrowthMax(series);
    if (max === null) {
        return toGrowthNoData(bound);
    }
    const warmUpMs = ttlMs + sweepMs;
    const lastElapsedMs = toGrowthLastElapsedMs(series);
    const windowStartMs = Math.max(lastElapsedMs - LAST_WINDOW_MS, warmUpMs);
    const firstPlateau = computeGrowthPlateau(series, warmUpMs);
    const slopePerHour = computeGrowthSlopePerHour(series, windowStartMs);
    if (lastElapsedMs - windowStartMs < MIN_SLOPE_WINDOW_MS || slopePerHour === null || firstPlateau === null) {
        return {
            bound,
            firstPlateau,
            slopePerHour,
            max,
            outcome: 'insufficient',
            reason: `the run ends ${toGrowthMinutes(lastElapsedMs)} min in; the plateau needs ` +
                `${toGrowthMinutes(warmUpMs + MIN_SLOPE_WINDOW_MS)} min`
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
            ? `grew ${toGrowthRounded(lastWindowGrowth)} in the last 15 min (tolerance ${toGrowthRounded(tolerance)})`
            : `still rising after ttl + sweep: ${toGrowthRounded(lastWindowGrowth)} in the last 15 min ` +
                `exceeds ${toGrowthRounded(tolerance)}`
    };
}

/**
 * Rows live out a time-to-live longer than the run, so they may grow at most linearly: the last 15 minutes within
 * 1.5 × the run's rate plus 60 rows an hour. The projection holds the faster of the two rates for one ttl, and never
 * less than the rows already held.
 */
function computeTtlBeyondRunAssessment(ttlMs: number, series: readonly GrowthSeriesPoint[]): GrowthAssessment {
    const toBound = (projected: number) =>
        `ttl ${toHours(ttlMs)} h; projected ≤ ${Math.round(projected)} (max(run, last 15 min) rate × ttl)`;
    const max = computeGrowthMax(series);
    const runRatePerHour = computeGrowthSlopePerHour(series, 0);
    if (max === null || runRatePerHour === null) {
        return toGrowthNoData(toBound(0));
    }
    const lastElapsedMs = toGrowthLastElapsedMs(series);
    const slopePerHour = computeGrowthSlopePerHour(series, lastElapsedMs - LAST_WINDOW_MS);
    const projectedRatePerHour = Math.max(runRatePerHour, slopePerHour ?? 0, 0);
    const projected = Math.max(max, projectedRatePerHour * (ttlMs / HOUR_MS));
    const bound = projected === 0 ? `ttl ${toHours(ttlMs)} h; projected ≤ 0 (no rows held)` : toBound(projected);
    const firstPlateau = computeGrowthPlateau(series, 0);
    if (lastElapsedMs < LAST_WINDOW_MS + MIN_SLOPE_WINDOW_MS || slopePerHour === null) {
        return {
            bound,
            firstPlateau,
            slopePerHour,
            max,
            outcome: 'insufficient',
            reason: `the run ends ${toGrowthMinutes(lastElapsedMs)} min in; a linear check needs ` +
                `${toGrowthMinutes(LAST_WINDOW_MS + MIN_SLOPE_WINDOW_MS)} min`
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
            ? `grows at most linearly: last 15 min ${toGrowthRounded(slopePerHour)}/h, run ${
                toGrowthRounded(runRatePerHour)
            }/h`
            : `accelerating: last 15 min ${toGrowthRounded(slopePerHour)}/h exceeds ${toGrowthRounded(limit)}/h`
    };
}

function computeHeapAssessment(series: readonly GrowthSeriesPoint[]): GrowthAssessment {
    const bound = `slope within ±${HEAP_SLOPE_LIMIT_BYTES_PER_HOUR / MB} MB/h after ` +
        `${toGrowthMinutes(HEAP_WARM_UP_MS)} min; max < ${HEAP_MAX_PLATEAU_FACTOR} × first plateau`;
    const afterWarmUp = series.filter((point) => point.elapsedMs >= HEAP_WARM_UP_MS);
    const max = computeGrowthMax(afterWarmUp);
    const firstPlateau = computeGrowthPlateau(series, HEAP_WARM_UP_MS);
    const slopePerHour = computeGrowthSlopePerHour(series, HEAP_WARM_UP_MS);
    if (series.length === 0) {
        return toGrowthNoData(bound);
    }
    if (
        max === null || firstPlateau === null || slopePerHour === null ||
        toGrowthLastElapsedMs(series) < HEAP_WARM_UP_MS + MIN_SLOPE_WINDOW_MS
    ) {
        return {
            bound,
            firstPlateau,
            slopePerHour,
            max: computeGrowthMax(series),
            outcome: 'insufficient',
            reason: `the run ends ${toGrowthMinutes(toGrowthLastElapsedMs(series))} min in; the heap check needs ` +
                `${toGrowthMinutes(HEAP_WARM_UP_MS + MIN_SLOPE_WINDOW_MS)} min`
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
        reason: `slope ${toGrowthRounded(slopePerHour / MB)} MB/h${flat ? '' : ' exceeds the limit'}; ` +
            `max ${toGrowthRounded(max / MB)} MB against the first plateau ` +
            `${toGrowthRounded(firstPlateau.value / MB)} MB` +
            `${belowDouble ? '' : ', twice it or more'}`
    };
}

function toHours(milliseconds: number): number {
    return Math.round((milliseconds / HOUR_MS) * 10) / 10;
}
