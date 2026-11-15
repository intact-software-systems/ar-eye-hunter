import { describe, expect, it } from 'vitest';

import {
    AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS,
    AL_PUBLICATION_FIGURE_PERCENT_BOUNDS,
    ALOutboundPublicationFigures,
    computeALOutboundPublicationFiguresAfterSelection,
    computeALOutboundPublicationFiguresAfterSubmission,
    toIdleALOutboundPublicationFigures
} from '@shared/alm/outbound/publication/al-outbound-publication-figures.ts';

const DRAIN = { messages: 4, bytes: 1000 };

function toSubmission(
    overrides: Partial<ALOutboundPublicationFigures.Submission>
): ALOutboundPublicationFigures.Submission {
    return { atMs: 1000, settledAtMs: 1003, selected: 2, selectedBytes: 500, drain: DRAIN, ...overrides };
}

describe('ALOutboundPublicationFigures', () => {
    it('records one selection age per selected value, from its staging instant to the opportunity', () => {
        const idle = toIdleALOutboundPublicationFigures();
        const figures = computeALOutboundPublicationFiguresAfterSelection(idle, {
            atMs: 1000,
            stagedAtMs: [999, 990, 400],
            missedOpportunities: 0
        });

        expect(figures.selectionAgeMs.count).toBe(3);
        expect(figures.selectionAgeMs.sum).toBe(611);
        expect(figures.selectionAgeMs.min).toBe(1);
        expect(figures.selectionAgeMs.max).toBe(600);
        expect(figures.selectionAgeMs.bucketCounts[AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS.indexOf(1)]).toBe(1);
        expect(figures.selectionAgeMs.bucketCounts[AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS.indexOf(10)]).toBe(1);
        expect(figures.selectionAgeMs.bucketCounts[AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS.indexOf(1000)]).toBe(1);
        // A selection settles no submission: the per-opportunity figures wait for it.
        expect(figures.submittedOpportunities).toBe(0);
        expect(figures.selectionToAdmissionMs.count).toBe(0);
        expect(idle.selectionAgeMs.count).toBe(0);
    });

    it('adds the missed boundaries a selection states', () => {
        const once = computeALOutboundPublicationFiguresAfterSelection(toIdleALOutboundPublicationFigures(), {
            atMs: 1000,
            stagedAtMs: [],
            missedOpportunities: 3
        });
        const twice = computeALOutboundPublicationFiguresAfterSelection(once, {
            atMs: 2000,
            stagedAtMs: [1990],
            missedOpportunities: 2
        });

        expect(once.missedOpportunities).toBe(3);
        expect(twice.missedOpportunities).toBe(5);
    });

    it('records the time to admission and both drain percents once per submission', () => {
        const idle = toIdleALOutboundPublicationFigures();
        const figures = computeALOutboundPublicationFiguresAfterSubmission(idle, toSubmission({}));

        expect(figures.submittedOpportunities).toBe(1);
        expect(figures.selectionToAdmissionMs.count).toBe(1);
        expect(figures.selectionToAdmissionMs.sum).toBe(3);
        expect(figures.drainMessagesPercent.count).toBe(1);
        expect(figures.drainMessagesPercent.sum).toBe(50);
        expect(figures.drainBytesPercent.count).toBe(1);
        expect(figures.drainBytesPercent.sum).toBe(50);
        expect(figures.selectionAgeMs.count).toBe(0);
        expect(figures.unrecordedSamples).toBe(0);
        expect(idle.submittedOpportunities).toBe(0);
    });

    it('counts a negative age as unrecorded and records nothing for it', () => {
        const idle = toIdleALOutboundPublicationFigures();
        const selected = computeALOutboundPublicationFiguresAfterSelection(idle, {
            atMs: 1000,
            stagedAtMs: [1005, 995],
            missedOpportunities: 0
        });
        const submitted = computeALOutboundPublicationFiguresAfterSubmission(
            selected,
            toSubmission({ atMs: 1000, settledAtMs: 998 })
        );

        expect(selected.selectionAgeMs.count).toBe(1);
        expect(selected.selectionAgeMs.sum).toBe(5);
        expect(selected.unrecordedSamples).toBe(1);
        expect(submitted.selectionToAdmissionMs.count).toBe(0);
        expect(submitted.drainMessagesPercent.count).toBe(1);
        expect(submitted.drainBytesPercent.count).toBe(1);
        expect(submitted.submittedOpportunities).toBe(1);
        expect(submitted.unrecordedSamples).toBe(2);
    });

    it('starts idle with empty histograms on the declared bounds and zero counts', () => {
        const idle = toIdleALOutboundPublicationFigures();

        for (const histogram of [idle.selectionAgeMs, idle.selectionToAdmissionMs]) {
            expect(histogram.upperBounds).toEqual(AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS);
            expect(histogram.bucketCounts).toEqual(new Array(AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS.length + 1).fill(0));
            expect(histogram.count).toBe(0);
            expect(histogram.min).toBeNull();
            expect(histogram.max).toBeNull();
        }
        for (const histogram of [idle.drainMessagesPercent, idle.drainBytesPercent]) {
            expect(histogram.upperBounds).toEqual(AL_PUBLICATION_FIGURE_PERCENT_BOUNDS);
            expect(histogram.bucketCounts).toEqual(new Array(AL_PUBLICATION_FIGURE_PERCENT_BOUNDS.length + 1).fill(0));
            expect(histogram.count).toBe(0);
        }
        expect(idle.submittedOpportunities).toBe(0);
        expect(idle.missedOpportunities).toBe(0);
        expect(idle.unrecordedSamples).toBe(0);
    });

    it('never grows: ten thousand selections keep every histogram\'s bucket count', () => {
        let figures = toIdleALOutboundPublicationFigures();
        for (let index = 0; index < 10_000; index += 1) {
            const atMs = index * 7;
            figures = computeALOutboundPublicationFiguresAfterSelection(figures, {
                atMs,
                stagedAtMs: [atMs - index],
                missedOpportunities: 0
            });
            figures = computeALOutboundPublicationFiguresAfterSubmission(
                figures,
                toSubmission({ atMs, settledAtMs: atMs + (index % 50), selected: 1 + (index % 4) })
            );
        }

        expect(figures.selectionAgeMs.bucketCounts).toHaveLength(AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS.length + 1);
        expect(figures.selectionToAdmissionMs.bucketCounts).toHaveLength(AL_PUBLICATION_FIGURE_AGE_BOUNDS_MS.length + 1);
        expect(figures.drainMessagesPercent.bucketCounts).toHaveLength(AL_PUBLICATION_FIGURE_PERCENT_BOUNDS.length + 1);
        expect(figures.drainBytesPercent.bucketCounts).toHaveLength(AL_PUBLICATION_FIGURE_PERCENT_BOUNDS.length + 1);
        expect(figures.selectionAgeMs.count).toBe(10_000);
        expect(figures.submittedOpportunities).toBe(10_000);
    });
});
