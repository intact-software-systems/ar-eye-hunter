import type { V1dGrowthPlateau, V1dGrowthSeriesPoint } from './v1d-growth-series.ts';

/**
 * `declared` is a history R3 declares and reports: never passed or failed. `unbounded-unexercised` is an unbounded
 * surface the workload never grew, so nothing proves it bounded: a follow-up, neither a pass nor a fail.
 */
export type V1dGrowthOutcome =
    | 'pass'
    | 'declared'
    | 'fail'
    | 'insufficient'
    | 'no-data'
    | 'unclassified'
    | 'unbounded-unexercised';

/** What one reading of one surface showed against its class's predicate. */
export interface V1dGrowthAssessment {
    readonly bound: string;
    readonly firstPlateau: V1dGrowthPlateau | null;
    /**
     * The slope the predicate read: the last 15 minutes; everything after the warm-up for the heap; the whole run for
     * a durable, declared or unbounded surface.
     */
    readonly slopePerHour: number | null;
    readonly max: number | null;
    readonly outcome: V1dGrowthOutcome;
    readonly reason: string;
}

export interface V1dGrowthSeriesInput {
    readonly series: readonly V1dGrowthSeriesPoint[];
    /** The entity counts a durable surface grows with, read from the same samples; empty for every other class. */
    readonly entitySeries: readonly V1dGrowthSeriesPoint[];
    /** The reading's rows stamped never to expire; empty where the store stamps none. */
    readonly neverExpiringSeries: readonly V1dGrowthSeriesPoint[];
}

export function toV1dGrowthNoData(bound: string): V1dGrowthAssessment {
    return {
        bound,
        firstPlateau: null,
        slopePerHour: null,
        max: null,
        outcome: 'no-data',
        reason: 'no sample carried this reading'
    };
}
