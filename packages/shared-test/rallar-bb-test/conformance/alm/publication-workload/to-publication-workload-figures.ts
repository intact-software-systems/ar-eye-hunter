import { AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS } from '@shared/alm/outbound/publication/al-outbound-publication-figures.ts';
import { isApiJsonObject, type ApiJsonValue } from '@shared/api/api-json-value.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { assertBoundedHistogram } from '@shared/measurement/assert-bounded-histogram.ts';
import { decodeBoundedHistogramOnBounds, type BoundedHistogram } from '@shared/measurement/bounded-histogram.ts';
import { computeBoundedHistogramMerged } from '@shared/measurement/compute-bounded-histogram-merged.ts';
import {
    computeBoundedHistogramQuantile,
    type BoundedHistogramQuantile
} from '@shared/measurement/compute-bounded-histogram-quantile.ts';
import { Either, EitherCollectors } from '@shared/resilience/Either.ts';

import type { AlmReceivedSampleAge } from '../../../alm/rallar-black-box-alm-result-values.ts';
import type { RallarBlackBoxDistributedGroupRef } from '../../../distributed-run.ts';
import { decodeNonNegativeInteger, decodeRecord } from '../../../runtime/decode-runtime-result-values.ts';

import { computePublicationWorkloadPlan, type PublicationWorkloadPlan } from './compute-publication-workload-plan.ts';
import {
    decodePublicationWorkloadPublisherFigures,
    type PublicationWorkloadPublisherFigures,
    type PublicationWorkloadPublisherResults
} from './decode-publication-workload-publisher-figures.ts';
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
    /** One entry per group of the point, in the point's order. */
    readonly rooms: readonly PublicationWorkloadRoomResults[];
}

/**
 * The results of one room's agents, by role: one result per publisher and per subscriber of the room. The point's
 * `publisherCount` and its plan's `subscriberCount` state how many those are, and no two results of a run are one
 * agent's.
 */
export interface PublicationWorkloadRoomResults {
    /** The group whose agents left the results, as the caller that gathered them states it. */
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly publishers: readonly PublicationWorkloadPublisherResults[];
    readonly subscribers: readonly PublicationWorkloadSubscriberResults[];
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
    /** One entry per group of the point, in the point's order. */
    readonly rooms: readonly PublicationWorkloadRoomFigures[];
    /** Every publisher result of every room together. */
    readonly published: PublicationWorkloadPublishedFigures;
    /** Every subscriber result of every room together. */
    readonly delivered: PublicationWorkloadDeliveredFigures;
}

export interface PublicationWorkloadRoomFigures {
    /** The group the run states for the room's results, which is the point's group at the room's place. */
    readonly group: RallarBlackBoxDistributedGroupRef;
    /** One entry per publisher of the room, in the order of the run's results. */
    readonly publishers: readonly PublicationWorkloadPublisherFigures[];
    /** One entry per subscriber of the room, in the order of the run's results. */
    readonly subscribers: readonly PublicationWorkloadSubscriberFigures[];
    /** The room's publisher results together. */
    readonly published: PublicationWorkloadPublishedFigures;
    /** The room's subscriber results together. */
    readonly delivered: PublicationWorkloadDeliveredFigures;
}

/**
 * Several publisher results as one, to read beside a delivered figure: what the stages handed to a carrier and what
 * their faults dropped, added. It divides by nothing, so it states no delivery ratio.
 */
export interface PublicationWorkloadPublishedFigures {
    /** The publisher results it covers. */
    readonly publisherCount: number;
    /** Their stages' `admitted` counters added. */
    readonly admittedFrames: number;
    /** Their `droppedSends` added; `null` for a point with no loss, as each of theirs is. */
    readonly droppedSends: number | null;
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

/** A subscriber's figures beside the histogram they summarise, which a delivered figure merges. */
interface DecodedSubscriber {
    readonly figures: PublicationWorkloadSubscriberFigures;
    readonly ageMs: BoundedHistogram;
}

interface DecodedRoom {
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly publishers: readonly PublicationWorkloadPublisherFigures[];
    readonly subscribers: readonly DecodedSubscriber[];
    readonly published: PublicationWorkloadPublishedFigures;
    readonly delivered: PublicationWorkloadDeliveredFigures;
}

/**
 * The left names every field that cannot be read, each issue starting with the field's path: under `$.parameters` a
 * bound of the family the point breaks, at `$.rooms` and under `$.rooms[r]` what `validateRunRooms` and then
 * `validateRunAgents` hold the run to, and under `$.rooms[r].publishers[p].loop`, `$.rooms[r].publishers[p].stats`,
 * `$.rooms[r].publishers[p].lossRelease` and `$.rooms[r].subscribers[s].received` a field of that result value.
 */
export function toPublicationWorkloadFigures(
    run: PublicationWorkloadRun
): Either<readonly string[], PublicationWorkloadFigures> {
    const parameterIssues = validatePublicationWorkloadParameters(run.parameters)
        .map((issue) => `$.parameters${issue.path.slice(1)} is not valid: ${issue.message}`);
    const plan = parameterIssues.length > 0 ? undefined : computePublicationWorkloadPlan(run.parameters);
    const rooms = run.rooms.map((room, index) => decodeRoom(room, `$.rooms[${index}]`, run.parameters));
    const decodedRooms = EitherCollectors.toListFoldRights(rooms);
    const delivered = computeDeliveredFigures(decodedRooms.flatMap((room) => room.subscribers));
    const issues = [
        ...parameterIssues,
        ...validateRunRooms(run, plan),
        ...validateRunAgents(run.rooms),
        ...EitherCollectors.toListFoldLefts(rooms).flat(),
        ...(delivered.left === undefined ? [] : [`$.rooms give no delivered sample age: ${delivered.left}`])
    ];
    if (issues.length > 0 || plan === undefined || delivered.right === undefined) {
        return Either.ofLeft(issues);
    }
    return Either.ofRight({
        configured: { parameters: run.parameters, plan },
        measured: {
            rooms: decodedRooms.map((room) => ({
                group: room.group,
                publishers: room.publishers,
                subscribers: room.subscribers.map((subscriber) => subscriber.figures),
                published: room.published,
                delivered: room.delivered
            })),
            published: computePublishedFigures(decodedRooms.flatMap((room) => room.publishers)),
            delivered: delivered.right
        }
    });
}

/**
 * What a run of the point holds: at `$.rooms` one room per group of the point; at `$.rooms[r].group` the point's group
 * at that place, so that no room's figures stand under another room's group; and at `$.rooms[r].publishers` and
 * `$.rooms[r].subscribers` one result per agent of that role, which only a point with a plan states. A result too few
 * leaves an agent out of the record.
 */
function validateRunRooms(run: PublicationWorkloadRun, plan: PublicationWorkloadPlan | undefined): readonly string[] {
    const { groups, publisherCount } = run.parameters;
    return [
        ...(run.rooms.length === groups.length
            ? []
            : [`$.rooms must hold one entry per room of the point, which has ${groups.length}`]),
        ...run.rooms.flatMap((room, index) => {
            const path = `$.rooms[${index}]`;
            const expectedPublisherCount = plan === undefined ? undefined : publisherCount;
            return [
                ...(index >= groups.length || isSameGroupRef(groups[index], room.group)
                    ? []
                    : [`${path}.group must be the point's group at that place, ${JSON.stringify(groups[index])}`]),
                ...validateRoleResultCount(room.publishers.length, expectedPublisherCount, `${path}.publishers`),
                ...validateRoleResultCount(room.subscribers.length, plan?.subscriberCount, `${path}.subscribers`)
            ];
        })
    ];
}

function validateRoleResultCount(
    resultCount: number,
    expectedCount: number | undefined,
    path: string
): readonly string[] {
    return expectedCount === undefined || resultCount === expectedCount
        ? []
        : [`${path} must hold ${expectedCount} results, one per agent of the role; it holds ${resultCount}`];
}

/**
 * A run names an agent once, whatever the room and the role: an agent runs one recipe in one room. A second result
 * under its id is the same result again, which would count its messages twice in a figure of the room or of the point,
 * or another agent's result under a wrong name. Each result after the first that names the agent is reported.
 */
function validateRunAgents(rooms: readonly PublicationWorkloadRoomResults[]): readonly string[] {
    const named = rooms.flatMap((room, index) => [
        ...room.publishers.map(({ agentId }, place) => ({ agentId, path: `$.rooms[${index}].publishers[${place}]` })),
        ...room.subscribers.map(({ agentId }, place) => ({ agentId, path: `$.rooms[${index}].subscribers[${place}]` }))
    ]);
    return named.flatMap(({ agentId, path }, index) => {
        const first = named.findIndex((earlier) => earlier.agentId === agentId);
        return first === index
            ? []
            : [`${path}.agentId must name another agent than ${named[first].path}.agentId, ${agentId}`];
    });
}

function decodeRoom(
    room: PublicationWorkloadRoomResults,
    path: string,
    parameters: PublicationWorkloadParameters
): Either<readonly string[], DecodedRoom> {
    const publishers = room.publishers
        .map((publisher, index) =>
            decodePublicationWorkloadPublisherFigures(publisher, `${path}.publishers[${index}]`, parameters.loss)
        );
    const subscribers = room.subscribers
        .map((subscriber, index) => decodeSubscriber(subscriber, `${path}.subscribers[${index}].received`));
    const decodedSubscribers = EitherCollectors.toListFoldRights(subscribers);
    const delivered = computeDeliveredFigures(decodedSubscribers);
    const issues = [
        ...EitherCollectors.toListFoldLefts(publishers).flat(),
        ...EitherCollectors.toListFoldLefts(subscribers).flat(),
        ...(delivered.left === undefined ? [] : [`${path}.subscribers give no delivered sample age: ${delivered.left}`])
    ];
    if (issues.length > 0 || delivered.right === undefined) {
        return Either.ofLeft(issues);
    }
    const decodedPublishers = EitherCollectors.toListFoldRights(publishers);
    return Either.ofRight({
        group: room.group,
        publishers: decodedPublishers,
        subscribers: decodedSubscribers,
        published: computePublishedFigures(decodedPublishers),
        delivered: delivered.right
    });
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

/**
 * Every publisher of a point holds a count of dropped sends or none, as its point's loss says; a point's publishers
 * share one loss, so the counts add up or the figure is `null` too.
 */
function computePublishedFigures(
    publishers: readonly PublicationWorkloadPublisherFigures[]
): PublicationWorkloadPublishedFigures {
    return {
        publisherCount: publishers.length,
        admittedFrames: publishers.reduce(
            (total, { publicationStage }) => total + publicationStage.counters.admitted,
            0
        ),
        droppedSends: publishers.reduce<number | null>(
            (total, { droppedSends }) => total === null || droppedSends === null ? null : total + droppedSends,
            0
        )
    };
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
