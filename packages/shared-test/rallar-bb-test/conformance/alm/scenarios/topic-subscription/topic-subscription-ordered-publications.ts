import type { ALInboundOrderingPosition } from '@shared/alm/inbound/admission/to-al-inbound-ordering-position.ts';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestWaitCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import { toOrderingPositionWait } from '../../alm-conformance-diagnostic-waits.ts';
import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import {
    toConfirmedCueWait,
    toPublicationWait,
    toPublishUntilConfirmedCommands
} from './topic-subscription-publications.ts';

export interface OrderedPublicationInput {
    readonly step: AlmConformanceStepInput;
    /** The publication's place on its producer's track, from 1; the page mints the sequence itself. */
    readonly publication: number;
    readonly confirmations: number;
    readonly outsideAudience: number;
}

/** The position event one publication of each producer's track leaves on the page. */
export interface OrderedPositionInput {
    readonly publication: number;
    readonly status: ALInboundOrderingPosition['status'];
    readonly priorSeq: number | null;
}

export interface OrderedPositionWaitsInput {
    readonly step: AlmConformanceStepInput;
    /** A publication the page received from each producer, whose arrival names the producer's peer id. */
    readonly arrival: number;
    readonly positions: readonly OrderedPositionInput[];
}

type OrderedTrack = 'a' | 'c';

/** Each producer publishes on a track of its own: the sender's is `a`, publisher-b's `c`. */
const ORDERED_TRACKS: readonly OrderedTrack[] = ['a', 'c'];

/** A probe's name: it rides no track, so it moves no recipient's position. */
const READINESS_PROBE = 'probe-ready';

/**
 * Probes until one copy reaches the cell's whole audience, so the first publication on the track leaves to an audience
 * that already holds every grant and election it needs and is confirmed by its first attempt: a retried attempt mints
 * a sequence of its own.
 */
export function toReadinessProbeCommands(
    step: AlmConformanceStepInput,
    confirmations: number,
    outsideAudience: number
): readonly RallarBlackBoxTestCommand[] {
    return toPublishUntilConfirmedCommands({
        step,
        name: READINESS_PROBE,
        confirmations,
        outsideAudience,
        kind: 'probe'
    });
}

/** One publication on the producer's own track, keyed by the cell, published until confirmed. */
export function toOrderedPublishCommands(
    { step, publication, confirmations, outsideAudience }: OrderedPublicationInput
): readonly RallarBlackBoxTestCommand[] {
    return toPublishUntilConfirmedCommands({
        step,
        name: toOrderedPublicationName(toProducerTrack(step), publication),
        confirmations,
        outsideAudience,
        kind: 'publication',
        orderingKey: step.scenarioKey
    });
}

/** Each producer's `publications` arrived on the page, the sender's track first. */
export function toOrderedArrivalWaits(
    step: AlmConformanceStepInput,
    publications: readonly number[]
): readonly RallarBlackBoxTestWaitCommand[] {
    return toOrderedPublicationNames(publications).map((publication) => toPublicationWait(step, publication, false));
}

/** None of each producer's `publications` arrived on the page. */
export function toOrderedAbsenceWaits(
    step: AlmConformanceStepInput,
    publications: readonly number[]
): readonly RallarBlackBoxTestWaitCommand[] {
    return toPublicationAbsenceWaits(step, toOrderedPublicationNames(publications));
}

/**
 * None of the named publications arrived on the page during the cell. Every absence reads the cell's whole history, so
 * the first one's window for a late copy covers the others, which read that history alone.
 */
export function toPublicationAbsenceWaits(
    step: AlmConformanceStepInput,
    publications: readonly string[]
): readonly RallarBlackBoxTestWaitCommand[] {
    return publications.map((publication, index) => {
        const wait = toPublicationWait(step, publication, true);
        return index === 0 ? wait : { ...wait, timeoutMs: 0 };
    });
}

/**
 * A producer's track on the page: the cell's ordering key and the producer's peer id, which the page read from its
 * `arrival` of one of the producer's publications, so a wait on the track follows that arrival's wait.
 */
export function toArrivedTrackKey(step: AlmConformanceStepInput, arrival: RallarBlackBoxTestWaitCommand): string {
    return `${step.scenarioKey}:{resultCache.${arrival.commandId}.value.event.payload.senderId}`;
}

/** Both producers' loops for `publication` ended: every recipient each waited for confirmed one copy. */
export function toOrderedConfirmedCueWaits(
    step: AlmConformanceStepInput,
    publication: number
): readonly RallarBlackBoxTestWaitCommand[] {
    return ORDERED_TRACKS.map((track) => toConfirmedCueWait(step, toOrderedPublicationName(track, publication)));
}

/**
 * The page's position events on each producer's track, the sender's first. A track's key names the producer's peer
 * id, which the page read from its arrival of the producer's `arrival`, so these waits follow that arrival's wait.
 */
export function toOrderedPositionWaits(
    { step, arrival, positions }: OrderedPositionWaitsInput
): readonly RallarBlackBoxTestWaitCommand[] {
    return ORDERED_TRACKS.flatMap((track) => {
        const received = toPublicationWait(step, toOrderedPublicationName(track, arrival), false);
        return positions.map(({ publication, status, priorSeq }) =>
            toOrderingPositionWait(step, {
                name: `${status}-${toOrderedPublicationName(track, publication)}`,
                status,
                priorSeq,
                track: toArrivedTrackKey(step, received)
            })
        );
    });
}

/** Each producer's `publications`, the sender's track first. */
function toOrderedPublicationNames(publications: readonly number[]): readonly string[] {
    return ORDERED_TRACKS.flatMap((track) =>
        publications.map((publication) => toOrderedPublicationName(track, publication))
    );
}

function toProducerTrack(producer: AlmConformanceStepInput): OrderedTrack {
    return producer.role === 'sender' ? 'a' : 'c';
}

function toOrderedPublicationName(track: OrderedTrack, publication: number): string {
    return `${track}-p${publication}`;
}
