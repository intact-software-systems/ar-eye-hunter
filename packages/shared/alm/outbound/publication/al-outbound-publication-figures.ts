import type { ALPublicationDrainBudget } from '../../../al-contracts/publication/al-publication-policy.ts';
import {
    computeBoundedHistogramAfter,
    createBoundedHistogram,
    type BoundedHistogram
} from '../../../measurement/bounded-histogram.ts';

export const AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS: readonly number[] = [
    1,
    2,
    5,
    10,
    20,
    50,
    100,
    200,
    500,
    1000,
    2000,
    5000,
    10000,
    30000,
    60000
];

export const AL_PUBLICATION_FIGURE_PERCENT_BOUNDS: readonly number[] = [10, 25, 50, 75, 90, 100];

export interface ALOutboundPublicationFigures {
    readonly selectionAgeMs: BoundedHistogram;
    readonly selectionToAdmissionMs: BoundedHistogram;
    readonly drainMessagesPercent: BoundedHistogram;
    readonly drainBytesPercent: BoundedHistogram;
    readonly submittedOpportunities: number;
    readonly missedOpportunities: number;
    readonly unrecordedSamples: number;
}

export namespace ALOutboundPublicationFigures {
    export interface Selection {
        readonly atMs: number;
        readonly stagedAtMs: readonly number[];
        readonly missedOpportunities: number;
    }

    export interface Submission {
        readonly atMs: number;
        readonly settledAtMs: number;
        readonly selected: number;
        readonly selectedBytes: number;
        readonly drain: ALPublicationDrainBudget;
    }
}

interface ALPublicationFigureRecorded {
    readonly histogram: BoundedHistogram;
    readonly unrecordedSamples: number;
}

function assertALPublicationFigureHistogram(upperBounds: readonly number[], named: string): BoundedHistogram {
    const created = createBoundedHistogram(upperBounds);
    if (created.right === undefined) {
        throw new Error(`${named} is not a valid set of histogram bounds: ${created.left}`);
    }
    return created.right;
}

export function toIdleALOutboundPublicationFigures(): ALOutboundPublicationFigures {
    const idleAge = assertALPublicationFigureHistogram(
        AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS,
        'AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS'
    );
    const idlePercent = assertALPublicationFigureHistogram(
        AL_PUBLICATION_FIGURE_PERCENT_BOUNDS,
        'AL_PUBLICATION_FIGURE_PERCENT_BOUNDS'
    );
    return {
        selectionAgeMs: idleAge,
        selectionToAdmissionMs: idleAge,
        drainMessagesPercent: idlePercent,
        drainBytesPercent: idlePercent,
        submittedOpportunities: 0,
        missedOpportunities: 0,
        unrecordedSamples: 0
    };
}

function computeALPublicationFigureRecorded(
    histogram: BoundedHistogram,
    values: readonly number[]
): ALPublicationFigureRecorded {
    return values.reduce<ALPublicationFigureRecorded>((recorded, value) => {
        const after = computeBoundedHistogramAfter(recorded.histogram, value);
        return after.right === undefined
            ? { histogram: recorded.histogram, unrecordedSamples: recorded.unrecordedSamples + 1 }
            : { histogram: after.right, unrecordedSamples: recorded.unrecordedSamples };
    }, { histogram, unrecordedSamples: 0 });
}

export function computeALOutboundPublicationFiguresAfterSelection(
    figures: ALOutboundPublicationFigures,
    selection: ALOutboundPublicationFigures.Selection
): ALOutboundPublicationFigures {
    const ages = computeALPublicationFigureRecorded(
        figures.selectionAgeMs,
        selection.stagedAtMs.map((stagedAtMs) => selection.atMs - stagedAtMs)
    );
    return {
        ...figures,
        selectionAgeMs: ages.histogram,
        missedOpportunities: figures.missedOpportunities + selection.missedOpportunities,
        unrecordedSamples: figures.unrecordedSamples + ages.unrecordedSamples
    };
}

export function computeALOutboundPublicationFiguresAfterSubmission(
    figures: ALOutboundPublicationFigures,
    submission: ALOutboundPublicationFigures.Submission
): ALOutboundPublicationFigures {
    const admission = computeALPublicationFigureRecorded(figures.selectionToAdmissionMs, [
        submission.settledAtMs - submission.atMs
    ]);
    const messages = computeALPublicationFigureRecorded(figures.drainMessagesPercent, [
        (100 * submission.selected) / submission.drain.messages
    ]);
    const bytes = computeALPublicationFigureRecorded(figures.drainBytesPercent, [
        (100 * submission.selectedBytes) / submission.drain.bytes
    ]);
    return {
        ...figures,
        selectionToAdmissionMs: admission.histogram,
        drainMessagesPercent: messages.histogram,
        drainBytesPercent: bytes.histogram,
        submittedOpportunities: figures.submittedOpportunities + 1,
        unrecordedSamples: figures.unrecordedSamples + admission.unrecordedSamples + messages.unrecordedSamples +
            bytes.unrecordedSamples
    };
}
