import { toV1dGrowthNoData, type V1dGrowthAssessment, type V1dGrowthSeriesInput } from './v1d-growth-assessment.ts';
import {
    computeV1dGrowthMax,
    computeV1dGrowthPlateau,
    computeV1dGrowthSlopePerHour,
    toV1dGrowthMinutes,
    toV1dGrowthRounded,
    type V1dGrowthSeriesPoint
} from './v1d-growth-series.ts';

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
