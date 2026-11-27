import { AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS } from '@shared/alm/outbound/publication/al-outbound-publication-figures.ts';
import type { ALOutboundPublicationStageReport } from '@shared/alm/outbound/publication/al-outbound-publication-stage.ts';
import { isApiJsonObject, type ApiJsonValue } from '@shared/api/api-json-value.ts';
import { assertBoundedHistogram } from '@shared/measurement/assert-bounded-histogram.ts';
import { decodeBoundedHistogramOnBounds, type BoundedHistogram } from '@shared/measurement/bounded-histogram.ts';
import { computeBoundedHistogramMerged } from '@shared/measurement/compute-bounded-histogram-merged.ts';
import {
    computeBoundedHistogramQuantile,
    type BoundedHistogramQuantile
} from '@shared/measurement/compute-bounded-histogram-quantile.ts';
import { Either, EitherCollectors } from '@shared/resilience/Either.ts';

import { decodeALOutboundPublicationStageReport } from '../../../alm/decode-al-outbound-publication-stage-report.ts';
import type { AlmReceivedSampleAge } from '../../../alm/rallar-black-box-alm-result-values.ts';
import type { RallarBlackBoxDistributedGroupRef } from '../../../distributed-run.ts';
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
    /** One entry per room of the point, in the point's order. */
    readonly rooms: readonly PublicationWorkloadRoomResults[];
}

/**
 * The results of one room's agents, by role: one result per publisher and per subscriber of the room, each of another
 * agent. The point's `publisherCount` and its plan's `subscriberCount` state how many those are.
 */
export interface PublicationWorkloadRoomResults {
    readonly publishers: readonly PublicationWorkloadPublisherResults[];
    readonly subscribers: readonly PublicationWorkloadSubscriberResults[];
}

export interface PublicationWorkloadPublisherResults {
    readonly agentId: string;
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
    /** One entry per room of the point, in the point's order. */
    readonly rooms: readonly PublicationWorkloadRoomFigures[];
    /** Every subscriber result of every room together. */
    readonly delivered: PublicationWorkloadDeliveredFigures;
}

export interface PublicationWorkloadRoomFigures {
    /** The point's group, by the room's place in the run. No result states the group it was read under. */
    readonly group: RallarBlackBoxDistributedGroupRef;
    /** One entry per publisher of the room, in the order of the run's results. */
    readonly publishers: readonly PublicationWorkloadPublisherFigures[];
    /** One entry per subscriber of the room, in the order of the run's results. */
    readonly subscribers: readonly PublicationWorkloadSubscriberFigures[];
    /** The room's subscriber results together. */
    readonly delivered: PublicationWorkloadDeliveredFigures;
}

export interface PublicationWorkloadPublisherFigures {
    readonly agentId: string;
    /**
     * The loop's `passed`: the sends the harness submitted. A live send returns as soon as its value is staged or
     * refused, so this is not what the stage handed to a carrier; `publicationStage.counters.admitted` is.
     */
    readonly submittedSends: number;
    readonly completedIterations: number;
    readonly elapsedMs: number;
    /**
     * The loop's `pacing.achievedRateHz`: its iterations, whether their send was accepted or not, as the n - 1
     * intervals between them over the loop's elapsed time, which includes the last child, to four places. `null`
     * where the loop states none, as a loop of one iteration does: the record is written as JSON, which keeps a `null`.
     */
    readonly achievedIterationRateHz: number | null;
    /** The publisher page's publication stage as its `stats` read it: holdings, limits, counters and figures. */
    readonly publicationStage: ALOutboundPublicationStageReport;
}

export interface PublicationWorkloadSubscriberFigures {
    readonly agentId: string;
    /** Every copy the count matched. More copies than the publishers had frames stay more: nothing clips it to the plan. */
    readonly observed: number;
    /** The matched copies that gave no age; `observed` is these and the recorded samples together. */
    readonly unrecordedSamples: number;
    readonly sampleAgeMs: PublicationWorkloadSampleAge;
}

/**
 * Several subscriber results as one: their copies and their unrecorded samples added, and every recorded age in one
 * histogram. A percentile of it therefore ranks every delivered sample; it is no mean of the subscribers' percentiles.
 */
export interface PublicationWorkloadDeliveredFigures {
    /** The subscriber results it covers. */
    readonly subscriberCount: number;
    readonly observed: number;
    readonly unrecordedSamples: number;
    readonly sampleAgeMs: PublicationWorkloadSampleAge;
}

/**
 * Delivered sample ages in milliseconds, of one subscriber or of several together: a subscriber's clock when its event
 * log recorded a copy, less the publisher's clock when its loop resolved that send. An age therefore holds the
 * harness's admission, the publication stage's hold, the transit, the delivery to the page's subscriber and the bridge
 * into the agent's runtime, and between two machines their clock offset too. It covers only the copies that arrived, so
 * it is read beside `observed`.
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

type PublicationWorkloadLoopFigures = Omit<PublicationWorkloadPublisherFigures, 'agentId' | 'publicationStage'>;

/** A subscriber's figures beside the histogram they summarise, which a delivered figure merges. */
interface DecodedSubscriber {
    readonly figures: PublicationWorkloadSubscriberFigures;
    readonly ageMs: BoundedHistogram;
}

interface DecodedRoom {
    readonly publishers: readonly PublicationWorkloadPublisherFigures[];
    readonly subscribers: readonly DecodedSubscriber[];
    readonly delivered: PublicationWorkloadDeliveredFigures;
}

/** How many results of each role a room of the point holds. A point that breaks a bound of the family states none. */
interface RoomRoleCounts {
    readonly publishers: number;
    readonly subscribers: number;
}

/**
 * The left names every field that cannot be read, each issue starting with the field's path: under `$.parameters` a
 * bound of the family the point breaks, `$.rooms` where the run holds another number of rooms than the point,
 * `$.rooms[r].publishers` and `$.rooms[r].subscribers` where a room holds another number of results than the point has
 * agents of that role, `...publishers[p].agentId` and `...subscribers[s].agentId` where a result repeats an agent of
 * its role, and under `$.rooms[r].publishers[p].loop`, `$.rooms[r].publishers[p].stats` and
 * `$.rooms[r].subscribers[s].received` a field of that result value.
 */
export function toPublicationWorkloadFigures(
    run: PublicationWorkloadRun
): Either<readonly string[], PublicationWorkloadFigures> {
    const parameterIssues = validatePublicationWorkloadParameters(run.parameters)
        .map((issue) => `$.parameters${issue.path.slice(1)} is not valid: ${issue.message}`);
    const roleCounts = parameterIssues.length > 0 ? undefined : {
        publishers: run.parameters.publisherCount,
        subscribers: computePublicationWorkloadPlan(run.parameters).subscriberCount
    };
    const groups = [run.parameters.group];
    const rooms = run.rooms.map((room, index) => decodeRoom(room, `$.rooms[${index}]`, roleCounts));
    const decodedRooms = EitherCollectors.toListFoldRights(rooms);
    const delivered = computeDeliveredFigures(decodedRooms.flatMap((room) => room.subscribers));
    const issues = [
        ...parameterIssues,
        ...(run.rooms.length === groups.length
            ? []
            : [`$.rooms must hold one entry per room of the point, which has ${groups.length}`]),
        ...EitherCollectors.toListFoldLefts(rooms).flat(),
        ...(delivered.left === undefined ? [] : [`$.rooms give no delivered sample age: ${delivered.left}`])
    ];
    if (issues.length > 0 || delivered.right === undefined) {
        return Either.ofLeft(issues);
    }
    return Either.ofRight({
        configured: { parameters: run.parameters, plan: computePublicationWorkloadPlan(run.parameters) },
        measured: {
            rooms: decodedRooms.map((room, index) => ({
                group: groups[index],
                publishers: room.publishers,
                subscribers: room.subscribers.map((subscriber) => subscriber.figures),
                delivered: room.delivered
            })),
            delivered: delivered.right
        }
    });
}

function decodeRoom(
    room: PublicationWorkloadRoomResults,
    path: string,
    roleCounts: RoomRoleCounts | undefined
): Either<readonly string[], DecodedRoom> {
    const publishers = room.publishers
        .map((publisher, index) => decodePublisherFigures(publisher, `${path}.publishers[${index}]`));
    const subscribers = room.subscribers
        .map((subscriber, index) => decodeSubscriber(subscriber, `${path}.subscribers[${index}].received`));
    const decodedSubscribers = EitherCollectors.toListFoldRights(subscribers);
    const delivered = computeDeliveredFigures(decodedSubscribers);
    const issues = [
        ...validateRoleResults(room.publishers, roleCounts?.publishers, `${path}.publishers`),
        ...EitherCollectors.toListFoldLefts(publishers).flat(),
        ...validateRoleResults(room.subscribers, roleCounts?.subscribers, `${path}.subscribers`),
        ...EitherCollectors.toListFoldLefts(subscribers).flat(),
        ...(delivered.left === undefined ? [] : [`${path}.subscribers give no delivered sample age: ${delivered.left}`])
    ];
    if (issues.length > 0 || delivered.right === undefined) {
        return Either.ofLeft(issues);
    }
    return Either.ofRight({
        publishers: EitherCollectors.toListFoldRights(publishers),
        subscribers: decodedSubscribers,
        delivered: delivered.right
    });
}

/**
 * A room holds one result per agent of a role. A result too few leaves an agent out of the record, and one given twice
 * counts its messages twice in every figure of the room and of the point.
 */
function validateRoleResults(
    results: readonly Readonly<{ agentId: string; }>[],
    expectedCount: number | undefined,
    path: string
): readonly string[] {
    return [
        ...(expectedCount === undefined || results.length === expectedCount
            ? []
            : [`${path} must hold ${expectedCount} results, one per agent of the role; it holds ${results.length}`]),
        ...results.flatMap(({ agentId }, index) => {
            const first = results.findIndex((result) => result.agentId === agentId);
            return first === index
                ? []
                : [`${path}[${index}].agentId must name another agent than ${path}[${first}].agentId, ${agentId}`];
        })
    ];
}

function decodePublisherFigures(
    publisher: PublicationWorkloadPublisherResults,
    path: string
): Either<readonly string[], PublicationWorkloadPublisherFigures> {
    const loop = decodeLoopFigures(publisher.loop, `${path}.loop`);
    const publicationStage = decodePublicationStage(publisher.stats, `${path}.stats.rallar.alm`);
    if (loop.right === undefined || publicationStage.right === undefined) {
        return Either.ofLeft([...(loop.left ?? []), ...(publicationStage.left ?? [])]);
    }
    return Either.ofRight({ agentId: publisher.agentId, ...loop.right, publicationStage: publicationStage.right });
}

function decodeLoopFigures(
    loop: ApiJsonValue | undefined,
    path: string
): Either<readonly string[], PublicationWorkloadLoopFigures> {
    const record = decodeRecord(loop);
    const pacing = decodeRecord(record.pacing);
    const submittedSends = decodeNonNegativeInteger(record.passed);
    const childResultCount = decodeNonNegativeInteger(record.childResultCount);
    const completedIterations = decodeNonNegativeInteger(pacing.completedIterations);
    const elapsedMs = decodeFiniteNumber(pacing.elapsedMs);
    const achievedRateHz = decodeFiniteNumber(pacing.achievedRateHz);
    const issues = [
        ...(submittedSends === undefined ? [`${path}.passed must be a whole number of at least 0`] : []),
        ...validateLoopChildResultCount(childResultCount, completedIterations, path),
        ...(completedIterations === undefined
            ? [`${path}.pacing.completedIterations must be a whole number of at least 0`]
            : []),
        ...(elapsedMs === undefined || elapsedMs < 0
            ? [`${path}.pacing.elapsedMs must be a finite number of at least 0`]
            : []),
        ...(pacing.achievedRateHz !== undefined && achievedRateHz === undefined
            ? [`${path}.pacing.achievedRateHz must be a finite number where the loop states one`]
            : [])
    ];
    if (
        issues.length > 0 || submittedSends === undefined || completedIterations === undefined ||
        elapsedMs === undefined
    ) {
        return Either.ofLeft(issues);
    }
    return Either.ofRight({
        submittedSends,
        completedIterations,
        elapsedMs,
        achievedIterationRateHz: achievedRateHz ?? null
    });
}

/**
 * The family's loop holds one send, so it ran one child per iteration. A loop that ran another number is not the
 * family's, and its `passed` would not count submitted sends.
 */
function validateLoopChildResultCount(
    childResultCount: number | undefined,
    completedIterations: number | undefined,
    path: string
): readonly string[] {
    if (childResultCount === undefined) {
        return [`${path}.childResultCount must be a whole number of at least 0`];
    }
    return completedIterations === undefined || childResultCount === completedIterations
        ? []
        : [`${path}.childResultCount must be ${path}.pacing.completedIterations, one child per iteration`];
}

/** The stage decoder names each bad field under `publication.`, the block `stats.rallar.alm` holds it in. */
function decodePublicationStage(
    stats: ApiJsonValue | undefined,
    almUsagePath: string
): Either<readonly string[], ALOutboundPublicationStageReport> {
    const { publication } = decodeRecord(decodeRecord(decodeRecord(stats).rallar).alm);
    return isApiJsonObject(publication)
        ? decodeALOutboundPublicationStageReport(publication)
            .mapLeft((issues) => issues.map((issue) => `${almUsagePath}.${issue}`))
        : Either.ofLeft([`${almUsagePath}.publication must be an object: the stats of a page that connected`]);
}

function decodeSubscriber(
    subscriber: PublicationWorkloadSubscriberResults,
    path: string
): Either<readonly string[], DecodedSubscriber> {
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
        figures: { agentId: subscriber.agentId, observed, unrecordedSamples, sampleAgeMs: toSampleAge(ageMs) },
        ageMs
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

/**
 * The merge starts from the histogram with no sample, so one subscriber reads as itself. Every subscriber's histogram
 * was decoded on the family's bounds, so the merge has nothing to refuse; a refusal would still be the left, not a
 * throw.
 */
function computeDeliveredFigures(
    subscribers: readonly DecodedSubscriber[]
): Either<string, PublicationWorkloadDeliveredFigures> {
    const noAgeMs = assertBoundedHistogram(AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS, 'AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS');
    return subscribers
        .reduce<Either<string, BoundedHistogram>>(
            (merged, subscriber) =>
                merged.flatMap(
                    (refusal) => Either.ofLeft(refusal),
                    (ageMs) => computeBoundedHistogramMerged(ageMs, subscriber.ageMs)
                ),
            Either.ofRight(noAgeMs)
        )
        .mapRight((ageMs) => ({
            subscriberCount: subscribers.length,
            observed: subscribers.reduce((total, { figures }) => total + figures.observed, 0),
            unrecordedSamples: subscribers.reduce((total, { figures }) => total + figures.unrecordedSamples, 0),
            sampleAgeMs: toSampleAge(ageMs)
        }));
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
