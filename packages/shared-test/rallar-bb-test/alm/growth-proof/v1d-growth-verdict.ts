import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import {
    computeV1dGrowthAssessment,
    type V1dGrowthAssessment,
    type V1dGrowthOutcome
} from './compute-v1d-growth-assessment.ts';
import { isApiJsonObject, toV1dGrowthSeries, type V1dGrowthSamplePoint } from './v1d-growth-series.ts';
import type {
    V1dGrowthClass,
    V1dGrowthReader,
    V1dGrowthSampleSource,
    V1dGrowthSurface
} from './v1d-growth-surface.ts';

export type V1dGrowthSamples = Readonly<Record<V1dGrowthSampleSource, readonly V1dGrowthSamplePoint[]>>;

/** The run fact every predicate reads: where the window starts. */
export interface V1dGrowthRun {
    readonly windowStartedAtEpochMs: number;
}

export interface V1dGrowthVerdictInput {
    /** The surfaces the growth survey found; each needs a classified surface. */
    readonly surveyedSurfaceIds: readonly number[];
    readonly surfaces: readonly V1dGrowthSurface[];
    readonly run: V1dGrowthRun;
    readonly samples: V1dGrowthSamples;
}

export interface V1dGrowthVerdictRow extends V1dGrowthAssessment {
    /** Null for a runtime-state namespace the samples hold but the survey never listed. */
    readonly surfaceId: number | null;
    readonly surface: string;
    readonly reader: string;
    readonly growthClass: V1dGrowthClass | 'unclassified';
}

export interface V1dGrowthVerdict {
    readonly passed: boolean;
    readonly rows: readonly V1dGrowthVerdictRow[];
}

const NAMESPACE_PATH = ['runtimeState', 'byNamespace'] as const;

export function computeV1dGrowthVerdict(input: V1dGrowthVerdictInput): V1dGrowthVerdict {
    const classifiedIds = new Set(input.surfaces.map((surface) => surface.id));
    const rows = [
        ...input.surfaces.flatMap((surface) =>
            surface.readers.map((reader) => computeV1dGrowthVerdictRow(surface, reader, input))
        ),
        ...input.surveyedSurfaceIds
            .filter((surfaceId) => !classifiedIds.has(surfaceId))
            .map((surfaceId) => toUnclassifiedRow(surfaceId, `survey surface ${surfaceId}`)),
        ...readUnreadNamespaces(input).map((namespace) =>
            toUnclassifiedRow(null, `runtime_state_store namespace ${namespace}`)
        )
    ];
    return { passed: rows.every((row) => row.outcome === 'pass'), rows };
}

function computeV1dGrowthVerdictRow(
    surface: V1dGrowthSurface,
    reader: V1dGrowthReader,
    input: V1dGrowthVerdictInput
): V1dGrowthVerdictRow {
    const toSeries = (seriesReader: V1dGrowthReader) =>
        toV1dGrowthSeries(input.samples[seriesReader.source], seriesReader, input.run.windowStartedAtEpochMs);
    const classification = surface.classification;
    return {
        surfaceId: surface.id,
        surface: surface.name,
        reader: `${reader.source} ${reader.path.join('.')}`,
        growthClass: classification.growthClass,
        ...computeV1dGrowthAssessment(classification, {
            series: toSeries(reader),
            neverExpiringSeries: reader.neverExpiringPath === null
                ? []
                : toSeries({ ...reader, path: reader.neverExpiringPath, neverExpiringPath: null })
        })
    };
}

function readUnreadNamespaces(input: V1dGrowthVerdictInput): readonly string[] {
    const read = new Set(
        input.surfaces.flatMap((surface) => surface.readers)
            .filter((reader) =>
                reader.source === 'postgres' && reader.path.length === NAMESPACE_PATH.length + 1 &&
                NAMESPACE_PATH.every((step, index) => reader.path[index] === step)
            )
            .map((reader) => reader.path[NAMESPACE_PATH.length]!)
    );
    const observed = new Set(input.samples.postgres.flatMap((point) => readNamespaces(point.value)));
    return [...observed].filter((namespace) => !read.has(namespace)).sort();
}

function readNamespaces(value: ApiJsonValue): readonly string[] {
    const runtimeState = isApiJsonObject(value) ? value[NAMESPACE_PATH[0]] : undefined;
    const byNamespace = isApiJsonObject(runtimeState) ? runtimeState[NAMESPACE_PATH[1]] : undefined;
    return isApiJsonObject(byNamespace) ? Object.keys(byNamespace) : [];
}

function toUnclassifiedRow(surfaceId: number | null, surface: string): V1dGrowthVerdictRow {
    const outcome: V1dGrowthOutcome = 'unclassified';
    return {
        surfaceId,
        surface,
        reader: 'none',
        growthClass: 'unclassified',
        bound: 'none',
        firstPlateau: null,
        slopePerHour: null,
        max: null,
        outcome,
        reason: 'no class, bound and reader: the verdict cannot judge it'
    };
}
