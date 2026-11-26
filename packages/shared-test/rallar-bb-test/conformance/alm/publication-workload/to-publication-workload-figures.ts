import { AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS } from '@shared/alm/outbound/publication/al-outbound-publication-figures.ts';
import type { ALOutboundPublicationStageReport } from '@shared/alm/outbound/publication/al-outbound-publication-stage.ts';
import { isApiJsonObject, type ApiJsonValue } from '@shared/api/api-json-value.ts';
import { decodeBoundedHistogramOnBounds, type BoundedHistogram } from '@shared/measurement/bounded-histogram.ts';
import {
    computeBoundedHistogramQuantile,
    type BoundedHistogramQuantile
} from '@shared/measurement/compute-bounded-histogram-quantile.ts';
import { Either, EitherCollectors } from '@shared/resilience/Either.ts';

import { decodeALOutboundPublicationStageReport } from '../../../alm/decode-al-outbound-publication-stage-report.ts';
import type { AlmReceivedSampleAge } from '../../../alm/rallar-black-box-alm-result-values.ts';
import {
    decodeFiniteNumber,
    decodeNonNegativeInteger,
    decodeRecord
} from '../../../runtime/decode-runtime-result-values.ts';

import { computePublicationWorkloadPlan, type PublicationWorkloadPlan } from './compute-publication-workload-plan.ts';
import { PUBLICATION_WORKLOAD_SENT_AT_FIELD } from './to-publication-workload-payload.ts';
import {
    validatePublicationWorkloadParameters,
    type PublicationWorkloadParameters
} from './validate-publication-workload-parameters.ts';

/**
 * One run of a point, as the result values of its agents state it. A value is the JSON a control connection or an
 * artifact carried, and `undefined` where the command's result holds none.
 */
export interface PublicationWorkloadRun {
    readonly parameters: PublicationWorkloadParameters;
    readonly publisher: PublicationWorkloadPublisherResults;
    readonly subscribers: readonly PublicationWorkloadSubscriberResults[];
}

export interface PublicationWorkloadPublisherResults {
    /** The `value` of the result of the publisher's `loop`. */
    readonly loop: ApiJsonValue | undefined;
    /** The `value` of the result of the `stats` the publisher read after its window. */
    readonly stats: ApiJsonValue | undefined;
}

export interface PublicationWorkloadSubscriberResults {
    readonly agentId: string;
    /** The `value` of the result of the subscriber's `messages.received`, whose command named `ageFrom`. */
    readonly received: ApiJsonValue | undefined;
}

/**
 * What a point asked for beside what its run observed. No field holds a value of both kinds, and the record judges
 * nothing: the asserts of the recipes are the gates.
 */
export interface PublicationWorkloadFigures {
    readonly configured: PublicationWorkloadConfiguredFigures;
    readonly measured: PublicationWorkloadMeasuredFigures;
}

export interface PublicationWorkloadConfiguredFigures {
    readonly parameters: PublicationWorkloadParameters;
    readonly plan: PublicationWorkloadPlan;
}

export interface PublicationWorkloadMeasuredFigures {
    readonly publisher: PublicationWorkloadPublisherFigures;
    /** One entry per subscriber result of the run, in its order; the plan's `subscriberCount` is how many it asked for. */
    readonly subscribers: readonly PublicationWorkloadSubscriberFigures[];
}

export interface PublicationWorkloadPublisherFigures {
    /** The loop's `passed`: the family's loop holds one send, so each child that passed is one accepted send. */
    readonly acceptedSends: number;
    readonly completedIterations: number;
    readonly elapsedMs: number;
    /** The loop's own rate, between the starts of its iterations; `undefined` where the loop states none. */
    readonly achievedRateHz: number | undefined;
    /** The publisher page's publication stage as its `stats` read it: holdings, limits, counters and figures. */
    readonly publicationStage: ALOutboundPublicationStageReport;
}

export interface PublicationWorkloadSubscriberFigures {
    readonly agentId: string;
    /** Every copy the count matched. More copies than the publisher had frames stay more: nothing clips it to the plan. */
    readonly observed: number;
    /** The matched copies that gave no age; `observed` is these and the recorded samples together. */
    readonly unrecordedSamples: number;
    readonly sampleAgeMs: PublicationWorkloadSampleAge;
}

/**
 * A subscriber's delivered sample ages in milliseconds: its clock when its event log recorded a copy, less the
 * publisher's clock when its loop resolved that send. An age therefore holds the harness's admission, the publication
 * stage's hold, the transit, the delivery to the page's subscriber and the bridge into the agent's runtime, and between
 * two machines their clock offset too. It covers only the copies that arrived, so it is read beside `observed`.
 */
export type PublicationWorkloadSampleAge = PublicationWorkloadNoSampleAge | PublicationWorkloadRecordedSampleAge;

/** No matched copy gave an age. Said outright, because a zero would read as a measured age. */
export interface PublicationWorkloadNoSampleAge {
    readonly kind: 'no-samples';
}

/** Each percentile is the bucket range of `computeBoundedHistogramQuantile`, never one value. */
export interface PublicationWorkloadRecordedSampleAge {
    readonly kind: 'recorded';
    readonly count: number;
    readonly min: number;
    readonly max: number;
    readonly p50: BoundedHistogramQuantile;
    readonly p95: BoundedHistogramQuantile;
    readonly p99: BoundedHistogramQuantile;
}

type PublicationWorkloadLoopFigures = Omit<PublicationWorkloadPublisherFigures, 'publicationStage'>;

const LOOP_PATH = '$.publisher.loop';
const ALM_USAGE_PATH = '$.publisher.stats.rallar.alm';

/**
 * The left names every field that cannot be read, each issue starting with the field's path: under `$.parameters` a
 * bound of the family the point breaks, under `$.publisher.loop`, `$.publisher.stats` and `$.subscribers[n].received`
 * a field of that result value.
 */
export function toPublicationWorkloadFigures(
    run: PublicationWorkloadRun
): Either<readonly string[], PublicationWorkloadFigures> {
    const parameterIssues = validatePublicationWorkloadParameters(run.parameters)
        .map((issue) => `$.parameters${issue.path.slice(1)} is not valid: ${issue.message}`);
    const loop = decodeLoopFigures(run.publisher.loop);
    const publicationStage = decodePublicationStage(run.publisher.stats);
    const subscribers = run.subscribers.map(decodeSubscriberFigures);
    const issues = [
        ...parameterIssues,
        ...(loop.left ?? []),
        ...(publicationStage.left ?? []),
        ...EitherCollectors.toListFoldLefts(subscribers).flat()
    ];
    if (issues.length > 0 || loop.right === undefined || publicationStage.right === undefined) {
        return Either.ofLeft(issues);
    }
    return Either.ofRight({
        configured: { parameters: run.parameters, plan: computePublicationWorkloadPlan(run.parameters) },
        measured: {
            publisher: { ...loop.right, publicationStage: publicationStage.right },
            subscribers: EitherCollectors.toListFoldRights(subscribers)
        }
    });
}

function decodeLoopFigures(
    loop: ApiJsonValue | undefined
): Either<readonly string[], PublicationWorkloadLoopFigures> {
    const record = decodeRecord(loop);
    const pacing = decodeRecord(record.pacing);
    const acceptedSends = decodeNonNegativeInteger(record.passed);
    const completedIterations = decodeNonNegativeInteger(pacing.completedIterations);
    const elapsedMs = decodeFiniteNumber(pacing.elapsedMs);
    const achievedRateHz = decodeFiniteNumber(pacing.achievedRateHz);
    const issues = [
        ...(acceptedSends === undefined ? [`${LOOP_PATH}.passed must be a whole number of at least 0`] : []),
        ...(completedIterations === undefined
            ? [`${LOOP_PATH}.pacing.completedIterations must be a whole number of at least 0`]
            : []),
        ...(elapsedMs === undefined || elapsedMs < 0
            ? [`${LOOP_PATH}.pacing.elapsedMs must be a finite number of at least 0`]
            : []),
        ...(pacing.achievedRateHz !== undefined && achievedRateHz === undefined
            ? [`${LOOP_PATH}.pacing.achievedRateHz must be a finite number where the loop states one`]
            : [])
    ];
    if (
        issues.length > 0 || acceptedSends === undefined || completedIterations === undefined || elapsedMs === undefined
    ) {
        return Either.ofLeft(issues);
    }
    return Either.ofRight({ acceptedSends, completedIterations, elapsedMs, achievedRateHz });
}

/** The stage decoder names each bad field under `publication.`, the block `stats.rallar.alm` holds it in. */
function decodePublicationStage(
    stats: ApiJsonValue | undefined
): Either<readonly string[], ALOutboundPublicationStageReport> {
    const { publication } = decodeRecord(decodeRecord(decodeRecord(stats).rallar).alm);
    return isApiJsonObject(publication)
        ? decodeALOutboundPublicationStageReport(publication)
            .mapLeft((issues) => issues.map((issue) => `${ALM_USAGE_PATH}.${issue}`))
        : Either.ofLeft([`${ALM_USAGE_PATH}.publication must be an object: the stats of a page that connected`]);
}

function decodeSubscriberFigures(
    subscriber: PublicationWorkloadSubscriberResults,
    index: number
): Either<readonly string[], PublicationWorkloadSubscriberFigures> {
    const path = `$.subscribers[${index}].received`;
    const received = decodeRecord(subscriber.received);
    const observed = decodeNonNegativeInteger(received.observed);
    const sampleAge = decodeSampleAge(received.sampleAge, `${path}.sampleAge`);
    if (observed === undefined || sampleAge.right === undefined) {
        return Either.ofLeft([
            ...(observed === undefined ? [`${path}.observed must be a whole number of at least 0`] : []),
            ...(sampleAge.left ?? [])
        ]);
    }
    const { ageMs, unrecordedSamples } = sampleAge.right;
    if (ageMs.count + unrecordedSamples !== observed) {
        return Either.ofLeft([
            `${path}.observed must be ${path}.sampleAge.ageMs.count and ${path}.sampleAge.unrecordedSamples together`
        ]);
    }
    return Either.ofRight({
        agentId: subscriber.agentId,
        observed,
        unrecordedSamples,
        sampleAgeMs: toSampleAge(ageMs)
    });
}

/** An age read from another payload field than the family's send stamp is not the family's delivered age. */
function decodeSampleAge(value: unknown, path: string): Either<readonly string[], AlmReceivedSampleAge> {
    if (!isApiJsonObject(value)) {
        return Either.ofLeft([`${path} must be an object: the count named no ageFrom`]);
    }
    const ageMs = decodeBoundedHistogramOnBounds(value.ageMs, `${path}.ageMs`, AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS);
    const unrecordedSamples = decodeNonNegativeInteger(value.unrecordedSamples);
    const issues = [
        ...(value.from === PUBLICATION_WORKLOAD_SENT_AT_FIELD
            ? []
            : [`${path}.from must be ${PUBLICATION_WORKLOAD_SENT_AT_FIELD}, the field of the family's send stamp`]),
        ...(ageMs.left ?? []),
        ...(unrecordedSamples === undefined ? [`${path}.unrecordedSamples must be a whole number of at least 0`] : [])
    ];
    if (issues.length > 0 || ageMs.right === undefined || unrecordedSamples === undefined) {
        return Either.ofLeft(issues);
    }
    return Either.ofRight({ from: PUBLICATION_WORKLOAD_SENT_AT_FIELD, ageMs: ageMs.right, unrecordedSamples });
}

function toSampleAge(ageMs: BoundedHistogram): PublicationWorkloadSampleAge {
    const p50 = computeBoundedHistogramQuantile(ageMs, 0.5);
    const p95 = computeBoundedHistogramQuantile(ageMs, 0.95);
    const p99 = computeBoundedHistogramQuantile(ageMs, 0.99);
    if (ageMs.min === null || ageMs.max === null || p50 === undefined || p95 === undefined || p99 === undefined) {
        return { kind: 'no-samples' };
    }
    return { kind: 'recorded', count: ageMs.count, min: ageMs.min, max: ageMs.max, p50, p95, p99 };
}
