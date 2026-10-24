import { toGrowthNoData, type GrowthAssessment, type GrowthSeriesInput } from './growth-assessment.ts';
import {
    computeGrowthMax,
    computeGrowthPlateau,
    computeGrowthSlopePerHour,
    toGrowthMinutes,
    toGrowthRounded,
    type GrowthSeriesPoint
} from './growth-series.ts';
import type { GrowthEntityCount } from './growth-surface.ts';

export interface GrowthDurableBound {
    readonly entity: string;
    readonly rowsPerEntity: number;
}

const HOURS_PER_DAY = 24;

/**
 * A durable surface grows only with new entities: at every sample its growth since the first stays within
 * `rowsPerEntity` per entity the entity reader counted new, plus one entity's rows of slack for the sample's skew.
 */
export function computeDurableAssessment(bound: GrowthDurableBound, input: GrowthSeriesInput): GrowthAssessment {
    const entityAt = new Map(input.entitySeries.map((point) => [point.elapsedMs, point.value]));
    const joined = input.series.flatMap((point) => {
        const entities = entityAt.get(point.elapsedMs);
        return entities === undefined ? [] : [{ ...point, entities }];
    });
    const ratePerHour = computeGrowthSlopePerHour(joined, 0);
    const boundText = `≤ ${bound.rowsPerEntity} per new ${bound.entity}; +${Math.round(ratePerHour ?? 0)}/h`;
    const first = joined[0];
    if (first === undefined) {
        return toGrowthNoData(boundText);
    }
    const limitAt = (entities: number) => bound.rowsPerEntity * (entities - first.entities + 1);
    const beyond = joined.find((point) => point.value - first.value > limitAt(point.entities));
    return {
        bound: boundText,
        firstPlateau: computeGrowthPlateau(joined, 0),
        slopePerHour: ratePerHour,
        max: computeGrowthMax(joined),
        outcome: beyond === undefined ? 'pass' : 'fail',
        reason: beyond === undefined
            ? `grew only with new ${bound.entity}`
            : `grew ${beyond.value - first.value} by ${toGrowthMinutes(beyond.elapsedMs)} min, beyond ` +
                `${limitAt(beyond.entities)} for ${beyond.entities - first.entities} new ${bound.entity}`
    };
}

/**
 * A surface of one row per registered account: at every sample its growth since the first stays within
 * `rowsPerEntity` per account the run registered, and no reading exceeds the ceiling reading of the same sample.
 */
export function computeRegisteredAssessment(
    bound: GrowthDurableBound,
    registrations: Extract<GrowthEntityCount, { source: 'registrations'; }>,
    input: GrowthSeriesInput
): GrowthAssessment {
    const accounts = input.workload === null
        ? null
        : input.workload.churnStarted * registrations.principalsPerChurnIteration + input.workload.manifestAgents;
    const ratePerHour = computeGrowthSlopePerHour(input.series, 0);
    const boundText = `≤ ${bound.rowsPerEntity} per ${bound.entity} (${accounts ?? 'unrecorded'}); ` +
        `+${Math.round(ratePerHour ?? 0)}/h`;
    const first = input.series[0];
    if (first === undefined || accounts === null) {
        return toGrowthNoData(boundText);
    }
    const ceilingAt = new Map(input.ceilingSeries.map((point) => [point.elapsedMs, point.value]));
    const limit = bound.rowsPerEntity * accounts;
    const beyond = input.series.find((point) => point.value - first.value > limit);
    const unceilinged = input.series.find((point) => !ceilingAt.has(point.elapsedMs));
    const aboveCeiling = input.series.find((point) => point.value > (ceilingAt.get(point.elapsedMs) ?? Number.NaN));
    return {
        bound: boundText,
        firstPlateau: computeGrowthPlateau(input.series, 0),
        slopePerHour: ratePerHour,
        max: computeGrowthMax(input.series),
        outcome: beyond === undefined && aboveCeiling === undefined && unceilinged === undefined ? 'pass' : 'fail',
        reason: beyond !== undefined
            ? `grew ${beyond.value - first.value} by ${toGrowthMinutes(beyond.elapsedMs)} min, beyond ` +
                `${limit} for ${accounts} ${bound.entity}`
            : unceilinged !== undefined
            ? `no ceiling reading at ${
                toGrowthMinutes(unceilinged.elapsedMs)
            } min to bound the ${unceilinged.value} read`
            : aboveCeiling !== undefined
            ? `${aboveCeiling.value} at ${toGrowthMinutes(aboveCeiling.elapsedMs)} min exceeds the ` +
                `${ceilingAt.get(aboveCeiling.elapsedMs)} its ceiling reading held`
            : `grew only with the ${accounts} ${bound.entity}`
    };
}

/** A history R3 declares and reports: its hourly growth and the day it projects at the run's rate, never judged. */
export function computeDeclaredAppendOnlyAssessment(
    history: string,
    series: readonly GrowthSeriesPoint[]
): GrowthAssessment {
    const ratePerHour = computeGrowthSlopePerHour(series, 0);
    const bound = `declared (${history}); +${Math.round(ratePerHour ?? 0)}/h, ` +
        `+${Math.round((ratePerHour ?? 0) * HOURS_PER_DAY)}/day at the run's rate`;
    const max = computeGrowthMax(series);
    if (max === null) {
        return toGrowthNoData(bound);
    }
    return {
        bound,
        firstPlateau: computeGrowthPlateau(series, 0),
        slopePerHour: ratePerHour,
        max,
        outcome: 'declared',
        reason: 'an accepted append-only history: its growth is reported, not judged'
    };
}

/** An unbounded surface fails when it grows; one flat throughout the run is unexercised, a follow-up. */
export function computeUnboundedAssessment(
    missingBound: string,
    series: readonly GrowthSeriesPoint[]
): GrowthAssessment {
    const bound = `none: ${missingBound}`;
    const max = computeGrowthMax(series);
    if (max === null) {
        return toGrowthNoData(bound);
    }
    const slopePerHour = computeGrowthSlopePerHour(series, 0);
    const grew = max > series[0]!.value;
    return {
        bound,
        firstPlateau: computeGrowthPlateau(series, 0),
        slopePerHour,
        max,
        outcome: grew ? 'fail' : 'unbounded-unexercised',
        reason: grew
            ? `no bound (${missingBound}); grew ${toGrowthRounded(slopePerHour ?? 0)}/h over the run`
            : `no bound (${missingBound}); the workload never grew it, so nothing proves it bounded`
    };
}
