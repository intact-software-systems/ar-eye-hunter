import { toV1dGrowthNoData, type V1dGrowthAssessment, type V1dGrowthSeriesInput } from './v1d-growth-assessment.ts';
import {
    computeV1dGrowthMax,
    computeV1dGrowthPlateau,
    computeV1dGrowthSlopePerHour,
    toV1dGrowthMinutes,
    toV1dGrowthRounded,
    type V1dGrowthSeriesPoint
} from './v1d-growth-series.ts';
import type { V1dGrowthEntityCount } from './v1d-growth-surface.ts';

export interface V1dDurableBound {
    readonly entity: string;
    readonly rowsPerEntity: number;
}

const HOURS_PER_DAY = 24;

/**
 * A durable surface grows only with new entities: at every sample its growth since the first stays within
 * `rowsPerEntity` per entity the entity reader counted new, plus one entity's rows of slack for the sample's skew.
 */
export function computeDurableAssessment(bound: V1dDurableBound, input: V1dGrowthSeriesInput): V1dGrowthAssessment {
    const entityAt = new Map(input.entitySeries.map((point) => [point.elapsedMs, point.value]));
    const joined = input.series.flatMap((point) => {
        const entities = entityAt.get(point.elapsedMs);
        return entities === undefined ? [] : [{ ...point, entities }];
    });
    const ratePerHour = computeV1dGrowthSlopePerHour(joined, 0);
    const boundText = `≤ ${bound.rowsPerEntity} per new ${bound.entity}; +${Math.round(ratePerHour ?? 0)}/h`;
    const first = joined[0];
    if (first === undefined) {
        return toV1dGrowthNoData(boundText);
    }
    const limitAt = (entities: number) => bound.rowsPerEntity * (entities - first.entities + 1);
    const beyond = joined.find((point) => point.value - first.value > limitAt(point.entities));
    return {
        bound: boundText,
        firstPlateau: computeV1dGrowthPlateau(joined, 0),
        slopePerHour: ratePerHour,
        max: computeV1dGrowthMax(joined),
        outcome: beyond === undefined ? 'pass' : 'fail',
        reason: beyond === undefined
            ? `grew only with new ${bound.entity}`
            : `grew ${beyond.value - first.value} by ${toV1dGrowthMinutes(beyond.elapsedMs)} min, beyond ` +
                `${limitAt(beyond.entities)} for ${beyond.entities - first.entities} new ${bound.entity}`
    };
}

/**
 * A surface of one row per registered account: at every sample its growth since the first stays within
 * `rowsPerEntity` per account the run registered, and no reading exceeds the ceiling reading of the same sample.
 */
export function computeRegisteredAssessment(
    bound: V1dDurableBound,
    registrations: Extract<V1dGrowthEntityCount, { source: 'registrations'; }>,
    input: V1dGrowthSeriesInput
): V1dGrowthAssessment {
    const accounts = input.workload === null
        ? null
        : input.workload.churnStarted * registrations.principalsPerChurnIteration + input.workload.manifestAgents;
    const ratePerHour = computeV1dGrowthSlopePerHour(input.series, 0);
    const boundText = `≤ ${bound.rowsPerEntity} per ${bound.entity} (${accounts ?? 'unrecorded'}); ` +
        `+${Math.round(ratePerHour ?? 0)}/h`;
    const first = input.series[0];
    if (first === undefined || accounts === null) {
        return toV1dGrowthNoData(boundText);
    }
    const ceilingAt = new Map(input.ceilingSeries.map((point) => [point.elapsedMs, point.value]));
    const limit = bound.rowsPerEntity * accounts;
    const beyond = input.series.find((point) => point.value - first.value > limit);
    const aboveCeiling = input.series.find((point) => point.value > (ceilingAt.get(point.elapsedMs) ?? point.value));
    return {
        bound: boundText,
        firstPlateau: computeV1dGrowthPlateau(input.series, 0),
        slopePerHour: ratePerHour,
        max: computeV1dGrowthMax(input.series),
        outcome: beyond === undefined && aboveCeiling === undefined ? 'pass' : 'fail',
        reason: beyond !== undefined
            ? `grew ${beyond.value - first.value} by ${toV1dGrowthMinutes(beyond.elapsedMs)} min, beyond ` +
                `${limit} for ${accounts} ${bound.entity}`
            : aboveCeiling !== undefined
            ? `${aboveCeiling.value} at ${toV1dGrowthMinutes(aboveCeiling.elapsedMs)} min exceeds the ` +
                `${ceilingAt.get(aboveCeiling.elapsedMs)} its ceiling reading held`
            : `grew only with the ${accounts} ${bound.entity}`
    };
}

/** A history R3 declares and reports: its hourly growth and the day it projects at the run's rate, never judged. */
export function computeDeclaredAppendOnlyAssessment(
    history: string,
    series: readonly V1dGrowthSeriesPoint[]
): V1dGrowthAssessment {
    const ratePerHour = computeV1dGrowthSlopePerHour(series, 0);
    const bound = `declared (${history}); +${Math.round(ratePerHour ?? 0)}/h, ` +
        `+${Math.round((ratePerHour ?? 0) * HOURS_PER_DAY)}/day at the run's rate`;
    const max = computeV1dGrowthMax(series);
    if (max === null) {
        return toV1dGrowthNoData(bound);
    }
    return {
        bound,
        firstPlateau: computeV1dGrowthPlateau(series, 0),
        slopePerHour: ratePerHour,
        max,
        outcome: 'declared',
        reason: 'an accepted append-only history: its growth is reported, not judged'
    };
}

/** An unbounded surface fails when it grows; one flat throughout the run is unexercised, a follow-up. */
export function computeUnboundedAssessment(
    missingBound: string,
    series: readonly V1dGrowthSeriesPoint[]
): V1dGrowthAssessment {
    const bound = `none: ${missingBound}`;
    const max = computeV1dGrowthMax(series);
    if (max === null) {
        return toV1dGrowthNoData(bound);
    }
    const slopePerHour = computeV1dGrowthSlopePerHour(series, 0);
    const grew = max > series[0]!.value;
    return {
        bound,
        firstPlateau: computeV1dGrowthPlateau(series, 0),
        slopePerHour,
        max,
        outcome: grew ? 'fail' : 'unbounded-unexercised',
        reason: grew
            ? `no bound (${missingBound}); grew ${toV1dGrowthRounded(slopePerHour ?? 0)}/h over the run`
            : `no bound (${missingBound}); the workload never grew it, so nothing proves it bounded`
    };
}
