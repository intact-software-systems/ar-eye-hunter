import {
    computeV1dGrowthMax,
    computeV1dGrowthPlateau,
    computeV1dGrowthSlopePerHour,
    type V1dGrowthPlateau,
    type V1dGrowthSeriesPoint
} from './v1d-growth-series.ts';
import type { V1dGrowthClassification } from './v1d-growth-surface.ts';

export type V1dGrowthOutcome = 'pass' | 'fail' | 'insufficient' | 'no-data' | 'unclassified';

/** What one reading of one surface showed against its class's predicate. */
export interface V1dGrowthAssessment {
    readonly bound: string;
    readonly firstPlateau: V1dGrowthPlateau | null;
    /** The slope the predicate read: the last 15 minutes, or everything after the warm-up for the heap. */
    readonly slopePerHour: number | null;
    readonly max: number | null;
    readonly outcome: V1dGrowthOutcome;
    readonly reason: string;
}

export interface V1dGrowthSeriesInput {
    readonly series: readonly V1dGrowthSeriesPoint[];
    /** The reading's rows stamped never to expire; empty where the store stamps none. */
    readonly neverExpiringSeries: readonly V1dGrowthSeriesPoint[];
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const MIB = 1_048_576;
const LAST_WINDOW_MS = 15 * MINUTE_MS;
const MIN_SLOPE_WINDOW_MS = 10 * MINUTE_MS;
const PLATEAU_RELATIVE_TOLERANCE = 0.05;
const PLATEAU_ABSOLUTE_TOLERANCE = 1;
const LINEAR_ACCELERATION_TOLERANCE = 0.5;
const LINEAR_ABSOLUTE_TOLERANCE_PER_HOUR = 4;
const HEAP_WARM_UP_MS = 10 * MINUTE_MS;
const HEAP_SLOPE_LIMIT_BYTES_PER_HOUR = 10 * MIB;
const HEAP_MAX_PLATEAU_FACTOR = 2;

export function computeV1dGrowthAssessment(
    classification: V1dGrowthClassification,
    input: V1dGrowthSeriesInput
): V1dGrowthAssessment {
    switch (classification.growthClass) {
        case 'count-capped':
            return computeCountCappedAssessment(classification.cap, input.series);
        case 'ttl-within-run':
            return withExpiryHeld(
                computeTtlWithinRunAssessment(classification.ttlMs, classification.sweepMs, input.series),
                input.neverExpiringSeries
            );
        case 'ttl-beyond-run':
            return withExpiryHeld(
                computeLinearAssessment(
                    input.series,
                    (ratePerHour) =>
                        `ttl ${toHours(classification.ttlMs)} h; projected ≤ ` +
                        `${Math.round(ratePerHour * (classification.ttlMs / HOUR_MS))} (rate × ttl)`
                ),
                input.neverExpiringSeries
            );
        case 'durable':
            return computeLinearAssessment(
                input.series,
                (ratePerHour) => `${classification.entity}; +${Math.round(ratePerHour)}/h`
            );
        case 'heap':
            return computeHeapAssessment(input.series);
        case 'unbounded':
            return computeUnboundedAssessment(classification.missingBound, input.series);
    }
}

/** A time-to-live bounds only rows that carry one: rows stamped never to expire that rise during the run fail it. */
function withExpiryHeld(
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
        return toNoData(bound);
    }
    return {
        bound,
        firstPlateau: computeV1dGrowthPlateau(series, 0),
        slopePerHour: computeV1dGrowthSlopePerHour(series, toLastElapsedMs(series) - LAST_WINDOW_MS),
        max,
        outcome: max <= cap ? 'pass' : 'fail',
        reason: max <= cap ? `every reading ≤ ${cap}` : `a reading of ${max} exceeds the cap ${cap}`
    };
}

function computeUnboundedAssessment(
    missingBound: string,
    series: readonly V1dGrowthSeriesPoint[]
): V1dGrowthAssessment {
    const bound = `none: ${missingBound}`;
    const max = computeV1dGrowthMax(series);
    if (max === null) {
        return toNoData(bound);
    }
    const slopePerHour = computeV1dGrowthSlopePerHour(series, 0);
    return {
        bound,
        firstPlateau: computeV1dGrowthPlateau(series, 0),
        slopePerHour,
        max,
        outcome: 'fail',
        reason: `no bound (${missingBound}); grew ${toRounded(slopePerHour ?? 0)}/h over the run`
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
        return toNoData(bound);
    }
    const warmUpMs = ttlMs + sweepMs;
    const lastElapsedMs = toLastElapsedMs(series);
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
            reason: `the run ends ${toMinutes(lastElapsedMs)} min in; the plateau needs ` +
                `${toMinutes(warmUpMs + MIN_SLOPE_WINDOW_MS)} min`
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
            ? `grew ${toRounded(lastWindowGrowth)} in the last 15 min (tolerance ${toRounded(tolerance)})`
            : `still rising after ttl + sweep: ${toRounded(lastWindowGrowth)} in the last 15 min ` +
                `exceeds ${toRounded(tolerance)}`
    };
}

function computeLinearAssessment(
    series: readonly V1dGrowthSeriesPoint[],
    toBound: (ratePerHour: number) => string
): V1dGrowthAssessment {
    const max = computeV1dGrowthMax(series);
    const runRatePerHour = computeV1dGrowthSlopePerHour(series, 0);
    if (max === null || runRatePerHour === null) {
        return toNoData(toBound(0));
    }
    const bound = toBound(Math.max(runRatePerHour, 0));
    const lastElapsedMs = toLastElapsedMs(series);
    const slopePerHour = computeV1dGrowthSlopePerHour(series, lastElapsedMs - LAST_WINDOW_MS);
    const firstPlateau = computeV1dGrowthPlateau(series, 0);
    if (lastElapsedMs < LAST_WINDOW_MS + MIN_SLOPE_WINDOW_MS || slopePerHour === null) {
        return {
            bound,
            firstPlateau,
            slopePerHour,
            max,
            outcome: 'insufficient',
            reason: `the run ends ${toMinutes(lastElapsedMs)} min in; a linear check needs ` +
                `${toMinutes(LAST_WINDOW_MS + MIN_SLOPE_WINDOW_MS)} min`
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
            ? `grows at most linearly: last 15 min ${toRounded(slopePerHour)}/h, run ${toRounded(runRatePerHour)}/h`
            : `accelerating: last 15 min ${toRounded(slopePerHour)}/h exceeds ${toRounded(limit)}/h`
    };
}

function computeHeapAssessment(series: readonly V1dGrowthSeriesPoint[]): V1dGrowthAssessment {
    const bound = `slope within ±${HEAP_SLOPE_LIMIT_BYTES_PER_HOUR / MIB} MiB/h after ` +
        `${toMinutes(HEAP_WARM_UP_MS)} min; max < ${HEAP_MAX_PLATEAU_FACTOR} × first plateau`;
    const afterWarmUp = series.filter((point) => point.elapsedMs >= HEAP_WARM_UP_MS);
    const max = computeV1dGrowthMax(afterWarmUp);
    const firstPlateau = computeV1dGrowthPlateau(series, HEAP_WARM_UP_MS);
    const slopePerHour = computeV1dGrowthSlopePerHour(series, HEAP_WARM_UP_MS);
    if (series.length === 0) {
        return toNoData(bound);
    }
    if (
        max === null || firstPlateau === null || slopePerHour === null ||
        toLastElapsedMs(series) < HEAP_WARM_UP_MS + MIN_SLOPE_WINDOW_MS
    ) {
        return {
            bound,
            firstPlateau,
            slopePerHour,
            max: computeV1dGrowthMax(series),
            outcome: 'insufficient',
            reason: `the run ends ${toMinutes(toLastElapsedMs(series))} min in; the heap check needs ` +
                `${toMinutes(HEAP_WARM_UP_MS + MIN_SLOPE_WINDOW_MS)} min`
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
        reason: `slope ${toRounded(slopePerHour / MIB)} MiB/h${flat ? '' : ' exceeds the limit'}; ` +
            `max ${toRounded(max / MIB)} MiB against the first plateau ${toRounded(firstPlateau.value / MIB)} MiB` +
            `${belowDouble ? '' : ', twice it or more'}`
    };
}

function toNoData(bound: string): V1dGrowthAssessment {
    return {
        bound,
        firstPlateau: null,
        slopePerHour: null,
        max: null,
        outcome: 'no-data',
        reason: 'no sample carried this reading'
    };
}

function toLastElapsedMs(series: readonly V1dGrowthSeriesPoint[]): number {
    return series.length === 0 ? 0 : series[series.length - 1]!.elapsedMs;
}

function toMinutes(milliseconds: number): number {
    return Math.round((milliseconds / MINUTE_MS) * 10) / 10;
}

function toHours(milliseconds: number): number {
    return Math.round((milliseconds / HOUR_MS) * 10) / 10;
}

function toRounded(value: number): number {
    return Math.round(value * 100) / 100;
}
