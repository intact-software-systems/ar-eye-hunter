import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import { computePageHeapAssessment, computeV1dGrowthAssessment } from './compute-v1d-growth-assessment.ts';
import type { V1dGrowthAssessment, V1dGrowthOutcome } from './v1d-growth-assessment.ts';
import {
    isApiJsonObject,
    toV1dGrowthAgentReadings,
    toV1dGrowthSeries,
    type V1dGrowthSamplePoint
} from './v1d-growth-series.ts';
import type {
    V1dGrowthClass,
    V1dGrowthReader,
    V1dGrowthSampleSource,
    V1dGrowthSurface
} from './v1d-growth-surface.ts';
import { computeV1dGrowthWorkloadIssues, type V1dGrowthWorkload } from './v1d-growth-workload.ts';

export type V1dGrowthSamples = Readonly<Record<V1dGrowthSampleSource, readonly V1dGrowthSamplePoint[]>>;

/** Where the run's window starts, and the workload outcome the script recorded when it closed. */
export interface V1dGrowthRun {
    readonly windowStartedAtEpochMs: number;
    /** Null when the run ended before the script recorded the workload's outcome. */
    readonly workload: V1dGrowthWorkload | null;
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

/** Passed only with a complete workload and every reading passing or declared. */
export interface V1dGrowthVerdict {
    readonly passed: boolean;
    readonly windowStartedAtEpochMs: number;
    readonly workload: V1dGrowthWorkload | null;
    readonly workloadIssues: readonly string[];
    /** The unbounded surfaces the workload never grew: neither passed nor failed, and named for follow-up. */
    readonly followUps: readonly string[];
    readonly rows: readonly V1dGrowthVerdictRow[];
}

const NAMESPACE_PATH = ['runtimeState', 'byNamespace'] as const;

/** Outcomes that do not block the verdict; an unexercised surface is listed as a follow-up instead. */
const SETTLED_OUTCOMES: ReadonlySet<V1dGrowthOutcome> = new Set(['pass', 'declared', 'unbounded-unexercised']);

export function computeV1dGrowthVerdict(input: V1dGrowthVerdictInput): V1dGrowthVerdict {
    const classifiedIds = new Set(input.surfaces.map((surface) => surface.id));
    const rows = [
        ...input.surfaces.flatMap((surface) =>
            surface.readers.flatMap((reader) =>
                toServiceIds(input.samples[reader.source]).map((serviceId) =>
                    computeV1dGrowthVerdictRow({ surface, reader, serviceId, verdictInput: input })
                )
            )
        ),
        ...input.surveyedSurfaceIds
            .filter((surfaceId) => !classifiedIds.has(surfaceId))
            .map((surfaceId) => toUnclassifiedRow(surfaceId, `survey surface ${surfaceId}`)),
        ...toUnreadNamespaces(input).map((namespace) =>
            toUnclassifiedRow(null, `runtime_state_store namespace ${namespace}`)
        )
    ];
    const workloadIssues = computeV1dGrowthWorkloadIssues(input.run.workload);
    return {
        passed: workloadIssues.length === 0 &&
            rows.every((row) => SETTLED_OUTCOMES.has(row.outcome)),
        windowStartedAtEpochMs: input.run.windowStartedAtEpochMs,
        workload: input.run.workload,
        workloadIssues,
        followUps: rows
            .filter((row) => row.outcome === 'unbounded-unexercised')
            .map((row) => `${row.surfaceId ?? '-'} ${row.surface} (${row.reader}) held at ${row.max}`),
        rows
    };
}

interface ComputeV1dGrowthVerdictRowInput {
    readonly surface: V1dGrowthSurface;
    readonly reader: V1dGrowthReader;
    /** The API process whose readings this row judges; null where the source's readings name no process. */
    readonly serviceId: string | null;
    readonly verdictInput: V1dGrowthVerdictInput;
}

function computeV1dGrowthVerdictRow(input: ComputeV1dGrowthVerdictRowInput): V1dGrowthVerdictRow {
    const { surface, reader, serviceId } = input;
    const readerPoints = input.verdictInput.samples[reader.source].filter((point) => point.serviceId === serviceId);
    // A browser agent samples its page heap without a forced collection, so the heap is judged on its bucket medians.
    const pageHeap = surface.classification.growthClass === 'heap' && reader.source === 'browser-stats';
    return {
        surfaceId: surface.id,
        surface: surface.name,
        reader: `${reader.source} ${reader.path.join('.')}${serviceId === null ? '' : ` ${serviceId}`}`,
        growthClass: surface.classification.growthClass,
        ...(pageHeap
            ? computePageHeapAssessment(
                toV1dGrowthAgentReadings(readerPoints, reader, input.verdictInput.run.windowStartedAtEpochMs)
            )
            : computeV1dGrowthClassAssessment(input, readerPoints))
    };
}

/** The reading judged by its surface's class, with the companion series that class reads from the same samples. */
function computeV1dGrowthClassAssessment(
    input: ComputeV1dGrowthVerdictRowInput,
    readerPoints: readonly V1dGrowthSamplePoint[]
): V1dGrowthAssessment {
    const { surface, reader } = input;
    const { samples, run } = input.verdictInput;
    const toSeries = (seriesReader: V1dGrowthReader) =>
        toV1dGrowthSeries(samples[seriesReader.source], seriesReader, run.windowStartedAtEpochMs);
    const classification = surface.classification;
    const entityCount = classification.growthClass === 'durable' ? classification.entityCount : undefined;
    return computeV1dGrowthAssessment(classification, {
        series: toV1dGrowthSeries(readerPoints, reader, run.windowStartedAtEpochMs),
        entitySeries: entityCount?.source === 'samples' ? toSeries(entityCount.reader) : [],
        ceilingSeries: entityCount?.source === 'registrations' ? toSeries(entityCount.ceiling) : [],
        neverExpiringSeries: reader.neverExpiringPath === null
            ? []
            : toSeries({ ...reader, path: reader.neverExpiringPath, neverExpiringPath: null }),
        workload: run.workload
    });
}

/** One row per API process where the readings name their process; one row otherwise, a no-data row without any. */
function toServiceIds(points: readonly V1dGrowthSamplePoint[]): readonly (string | null)[] {
    const serviceIds = [...new Set(points.map((point) => point.serviceId))];
    return serviceIds.length === 0 ? [null] : serviceIds.sort();
}

function toUnreadNamespaces(input: V1dGrowthVerdictInput): readonly string[] {
    const read = new Set(
        input.surfaces.flatMap((surface) => surface.readers)
            .filter((reader) =>
                reader.source === 'postgres' && reader.path.length === NAMESPACE_PATH.length + 1 &&
                NAMESPACE_PATH.every((step, index) => reader.path[index] === step)
            )
            .map((reader) => reader.path[NAMESPACE_PATH.length]!)
    );
    const observed = new Set(input.samples.postgres.flatMap((point) => toNamespaces(point.value)));
    return [...observed].filter((namespace) => !read.has(namespace)).sort();
}

function toNamespaces(value: ApiJsonValue): readonly string[] {
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
