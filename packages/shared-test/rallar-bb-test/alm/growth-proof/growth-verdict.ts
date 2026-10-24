import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import { computeGrowthAssessment } from './compute-growth-assessment.ts';
import { computeGrowthPageHeapAssessment } from './compute-growth-page-heap-assessment.ts';
import type { GrowthAssessment, GrowthOutcome } from './growth-assessment.ts';
import {
    isApiJsonObject,
    toGrowthAgentReadings,
    toGrowthSeries,
    type GrowthSamplePoint
} from './growth-series.ts';
import type {
    GrowthClass,
    GrowthReader,
    GrowthSampleSource,
    GrowthSurface
} from './growth-surface.ts';
import { computeGrowthWorkloadIssues, type GrowthWorkload } from './growth-workload.ts';

export type GrowthSamples = Readonly<Record<GrowthSampleSource, readonly GrowthSamplePoint[]>>;

/** Where the run's window starts, and the workload outcome the script recorded when it closed. */
export interface GrowthRun {
    readonly windowStartedAtEpochMs: number;
    /** Null when the run ended before the script recorded the workload's outcome. */
    readonly workload: GrowthWorkload | null;
}

export interface GrowthVerdictInput {
    /** The surfaces the growth survey found; each needs a classified surface. */
    readonly surveyedSurfaceIds: readonly number[];
    readonly surfaces: readonly GrowthSurface[];
    readonly run: GrowthRun;
    readonly samples: GrowthSamples;
}

export interface GrowthVerdictRow extends GrowthAssessment {
    /** Null for a runtime-state namespace the samples hold but the survey never listed. */
    readonly surfaceId: number | null;
    readonly surface: string;
    readonly reader: string;
    readonly growthClass: GrowthClass | 'unclassified';
}

/** Passed only with a complete workload and every reading passing or declared. */
export interface GrowthVerdict {
    readonly passed: boolean;
    readonly windowStartedAtEpochMs: number;
    readonly workload: GrowthWorkload | null;
    readonly workloadIssues: readonly string[];
    /** The unbounded surfaces the workload never grew: neither passed nor failed, and named for follow-up. */
    readonly followUps: readonly string[];
    readonly rows: readonly GrowthVerdictRow[];
}

const NAMESPACE_PATH = ['runtimeState', 'byNamespace'] as const;

/** Outcomes that do not block the verdict; an unexercised surface is listed as a follow-up instead. */
const SETTLED_OUTCOMES: ReadonlySet<GrowthOutcome> = new Set(['pass', 'declared', 'unbounded-unexercised']);

export function computeGrowthVerdict(input: GrowthVerdictInput): GrowthVerdict {
    const classifiedIds = new Set(input.surfaces.map((surface) => surface.id));
    const rows = [
        ...input.surfaces.flatMap((surface) =>
            surface.readers.flatMap((reader) =>
                toServiceIds(input.samples[reader.source], reader.source, input.run.workload).map((serviceId) =>
                    computeGrowthVerdictRow({ surface, reader, serviceId, verdictInput: input })
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
    const workloadIssues = computeGrowthWorkloadIssues(input.run.workload);
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

interface ComputeGrowthVerdictRowInput {
    readonly surface: GrowthSurface;
    readonly reader: GrowthReader;
    /** The API process whose readings this row judges; null where the source's readings name no process. */
    readonly serviceId: string | null;
    readonly verdictInput: GrowthVerdictInput;
}

function computeGrowthVerdictRow(input: ComputeGrowthVerdictRowInput): GrowthVerdictRow {
    const { surface, reader, serviceId } = input;
    const readerPoints = input.verdictInput.samples[reader.source].filter((point) => point.serviceId === serviceId);
    const pageHeap = surface.classification.growthClass === 'heap' && reader.source === 'browser-stats';
    return {
        surfaceId: surface.id,
        surface: surface.name,
        reader: `${reader.source} ${reader.path.join('.')}${serviceId === null ? '' : ` ${serviceId}`}`,
        growthClass: surface.classification.growthClass,
        ...(pageHeap
            ? computeGrowthPageHeapAssessment(
                toGrowthAgentReadings(readerPoints, reader, input.verdictInput.run.windowStartedAtEpochMs)
            )
            : computeGrowthClassAssessment(input, readerPoints))
    };
}

/** The reading judged by its surface's class, with the companion series that class reads from the same samples. */
function computeGrowthClassAssessment(
    input: ComputeGrowthVerdictRowInput,
    readerPoints: readonly GrowthSamplePoint[]
): GrowthAssessment {
    const { surface, reader } = input;
    const { samples, run } = input.verdictInput;
    const toSeries = (seriesReader: GrowthReader) =>
        toGrowthSeries(samples[seriesReader.source], seriesReader, run.windowStartedAtEpochMs);
    const classification = surface.classification;
    const entityCount = classification.growthClass === 'durable' ? classification.entityCount : undefined;
    return computeGrowthAssessment(classification, {
        series: toGrowthSeries(readerPoints, reader, run.windowStartedAtEpochMs),
        entitySeries: entityCount?.source === 'samples' ? toSeries(entityCount.reader) : [],
        ceilingSeries: entityCount?.source === 'registrations' ? toSeries(entityCount.ceiling) : [],
        neverExpiringSeries: reader.neverExpiringPath === null
            ? []
            : toSeries({ ...reader, path: reader.neverExpiringPath, neverExpiringPath: null }),
        workload: run.workload
    });
}

/**
 * One row per API process where the readings name their process; one row otherwise, a no-data row without any. Where
 * some of the processes the run recorded starting sampled no heap, each absent one gets a no-data row of its own.
 */
function toServiceIds(
    points: readonly GrowthSamplePoint[],
    source: GrowthSampleSource,
    workload: GrowthWorkload | null
): readonly (string | null)[] {
    const serviceIds = [...new Set(points.map((point) => point.serviceId))].sort();
    if (serviceIds.length === 0) {
        return [null];
    }
    const named = serviceIds.filter((serviceId) => serviceId !== null).length;
    const absent = source === 'api-heap' && workload !== null && named > 0 ? workload.apiProcesses - named : 0;
    return [
        ...serviceIds,
        ...Array.from({ length: Math.max(absent, 0) }, (_, index) => `unreported process ${index + 1}`)
    ];
}

function toUnreadNamespaces(input: GrowthVerdictInput): readonly string[] {
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

function toUnclassifiedRow(surfaceId: number | null, surface: string): GrowthVerdictRow {
    const outcome: GrowthOutcome = 'unclassified';
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
