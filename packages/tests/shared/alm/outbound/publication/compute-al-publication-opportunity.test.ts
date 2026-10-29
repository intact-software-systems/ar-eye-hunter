import { describe, expect, it } from 'vitest';

import { computeALPublicationNextOpportunityAtMs } from '@shared/alm/outbound/publication/compute-al-publication-opportunity.ts';

const CADENCE_MS = 100;

describe('computeALPublicationNextOpportunityAtMs', () => {
    it('opens an opportunity at once on a lane that never ran one', () => {
        expect(computeALPublicationNextOpportunityAtMs({
            lastOpportunityAtMs: undefined,
            cadenceMs: CADENCE_MS,
            nowMs: 5_000
        })).toBe(5_000);
    });

    it('waits for the boundary one cadence after the last opportunity', () => {
        expect(computeALPublicationNextOpportunityAtMs({
            lastOpportunityAtMs: 5_000,
            cadenceMs: CADENCE_MS,
            nowMs: 5_000
        })).toBe(5_100);
        expect(computeALPublicationNextOpportunityAtMs({
            lastOpportunityAtMs: 5_000,
            cadenceMs: CADENCE_MS,
            nowMs: 5_100
        })).toBe(5_100);
    });

    it('runs one opportunity now, not a catch-up burst, when the lane is ten cadences late', () => {
        const lateNowMs = 5_000 + 10 * CADENCE_MS;
        const runAtMs = computeALPublicationNextOpportunityAtMs({
            lastOpportunityAtMs: 5_000,
            cadenceMs: CADENCE_MS,
            nowMs: lateNowMs
        });

        expect(runAtMs).toBe(lateNowMs);
        expect(computeALPublicationNextOpportunityAtMs({
            lastOpportunityAtMs: runAtMs,
            cadenceMs: CADENCE_MS,
            nowMs: lateNowMs
        })).toBe(lateNowMs + CADENCE_MS);
    });
});
