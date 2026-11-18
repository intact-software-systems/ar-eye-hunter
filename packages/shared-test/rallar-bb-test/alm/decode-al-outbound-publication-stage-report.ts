import type { ALPublicationStageLimits } from '@shared/al-contracts/publication/al-publication-stage-limits.ts';
import {
    AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS,
    AL_PUBLICATION_FIGURE_PERCENT_BOUNDS,
    type ALOutboundPublicationFigures
} from '@shared/alm/outbound/publication/al-outbound-publication-figures.ts';
import type { ALOutboundPublicationCounters } from '@shared/alm/outbound/publication/al-outbound-publication-ledger.ts';
import type { ALOutboundPublicationStageReport } from '@shared/alm/outbound/publication/al-outbound-publication-stage.ts';
import { decodeBoundedHistogram, type BoundedHistogram } from '@shared/measurement/bounded-histogram.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';
import { decodeRecord } from '../runtime/decode-runtime-result-values.ts';
import { decodeCounts } from './decode-al-volatile-session-report.ts';

const HOLDING_FIELDS = [
    'lanes',
    'streams',
    'staged',
    'stagedBytes'
] as const satisfies readonly (keyof ALOutboundPublicationStageReport)[];
const LIMIT_FIELDS = [
    'maxStreams',
    'maxStagedValues',
    'maxStagedBytes'
] as const satisfies readonly (keyof ALPublicationStageLimits)[];
const COUNTER_FIELDS = [
    'staged',
    'superseded',
    'expired',
    'refused',
    'cancelled',
    'admitted',
    'deferred'
] as const satisfies readonly (keyof ALOutboundPublicationCounters)[];
const FIGURE_COUNT_FIELDS = [
    'submittedOpportunities',
    'missedOpportunities',
    'unrecordedSamples'
] as const satisfies readonly (keyof ALOutboundPublicationFigures)[];

type FigureHistogramField = Exclude<keyof ALOutboundPublicationFigures, (typeof FIGURE_COUNT_FIELDS)[number]>;

const FIGURE_HISTOGRAM_BOUNDS: Readonly<Record<FigureHistogramField, readonly number[]>> = {
    selectionAgeMs: AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS,
    selectionToAdmissionMs: AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS,
    drainMessagesPercent: AL_PUBLICATION_FIGURE_PERCENT_BOUNDS,
    drainBytesPercent: AL_PUBLICATION_FIGURE_PERCENT_BOUNDS
};

/** A page's `stats.rallar.alm.publication` block (D480); the left names every bad field under `publication.`. */
export function decodeALOutboundPublicationStageReport(
    value: unknown
): Either<readonly string[], ALOutboundPublicationStageReport> {
    const record = decodeRecord(value);
    const holdings = decodeCounts(value, HOLDING_FIELDS, 'publication');
    const limits = decodeCounts(record.limits, LIMIT_FIELDS, 'publication.limits');
    const counters = decodeCounts(record.counters, COUNTER_FIELDS, 'publication.counters');
    const figures = decodeFigures(decodeRecord(record.figures));
    if (
        holdings.right === undefined || limits.right === undefined || counters.right === undefined ||
        figures.right === undefined
    ) {
        return Either.ofLeft([
            ...(holdings.left ?? []),
            ...(limits.left ?? []),
            ...(counters.left ?? []),
            ...(figures.left ?? [])
        ]);
    }
    const { lanes, streams, staged, stagedBytes } = holdings.right;
    const { maxStreams, maxStagedValues, maxStagedBytes } = limits.right;
    return Either.ofRight({
        lanes,
        streams,
        staged,
        stagedBytes,
        limits: { maxStreams, maxStagedValues, maxStagedBytes },
        counters: toCounters(counters.right),
        figures: figures.right
    });
}

function decodeFigures(record: RallarBlackBoxTestRecord): Either<readonly string[], ALOutboundPublicationFigures> {
    const selectionAgeMs = decodeFigureHistogram(record, 'selectionAgeMs');
    const selectionToAdmissionMs = decodeFigureHistogram(record, 'selectionToAdmissionMs');
    const drainMessagesPercent = decodeFigureHistogram(record, 'drainMessagesPercent');
    const drainBytesPercent = decodeFigureHistogram(record, 'drainBytesPercent');
    const counts = decodeCounts(record, FIGURE_COUNT_FIELDS, 'publication.figures');
    if (
        selectionAgeMs.right === undefined || selectionToAdmissionMs.right === undefined ||
        drainMessagesPercent.right === undefined || drainBytesPercent.right === undefined || counts.right === undefined
    ) {
        return Either.ofLeft([
            ...(selectionAgeMs.left ?? []),
            ...(selectionToAdmissionMs.left ?? []),
            ...(drainMessagesPercent.left ?? []),
            ...(drainBytesPercent.left ?? []),
            ...(counts.left ?? [])
        ]);
    }
    const { submittedOpportunities, missedOpportunities, unrecordedSamples } = counts.right;
    return Either.ofRight({
        selectionAgeMs: selectionAgeMs.right,
        selectionToAdmissionMs: selectionToAdmissionMs.right,
        drainMessagesPercent: drainMessagesPercent.right,
        drainBytesPercent: drainBytesPercent.right,
        submittedOpportunities,
        missedOpportunities,
        unrecordedSamples
    });
}

/** One bound set per figure, so the figures of two pages stay comparable bucket by bucket. */
function decodeFigureHistogram(
    record: RallarBlackBoxTestRecord,
    field: FigureHistogramField
): Either<readonly string[], BoundedHistogram> {
    const path = `publication.figures.${field}`;
    const histogram = decodeBoundedHistogram(record[field], path);
    if (histogram.right === undefined) {
        return histogram;
    }
    const declared = FIGURE_HISTOGRAM_BOUNDS[field];
    const { upperBounds } = histogram.right;
    return upperBounds.length === declared.length && upperBounds.every((bound, index) => bound === declared[index])
        ? histogram
        : Either.ofLeft([`${path}.upperBounds are not the bounds the stage declares for it`]);
}

function toCounters(
    counters: Readonly<Record<keyof ALOutboundPublicationCounters, number>>
): ALOutboundPublicationCounters {
    const { staged, superseded, expired, refused, cancelled, admitted, deferred } = counters;
    return { staged, superseded, expired, refused, cancelled, admitted, deferred };
}
