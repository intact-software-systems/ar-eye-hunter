import { describe, expect, it } from 'vitest';

import { computeInFlightDialAdmission } from '@shared/api/group-lifecycle/compute-in-flight-dial-admission.ts';

describe('computeInFlightDialAdmission', () => {
    it('admits while every owning group has a free slot', () => {
        expect(computeInFlightDialAdmission({
            owningGroupBudgets: [
                { inFlightSetupCount: 1, maxConcurrentEdgeSetups: 2 },
                { inFlightSetupCount: 0, maxConcurrentEdgeSetups: 1 }
            ]
        })).toBe('admit');
    });

    // Product decision 18: a shared peer waits while any owning group is at
    // its bound, even if another is idle — starting anyway would put the
    // saturated group over the bound its own policy asked for.
    it('waits while any owning group is at its bound', () => {
        expect(computeInFlightDialAdmission({
            owningGroupBudgets: [
                { inFlightSetupCount: 0, maxConcurrentEdgeSetups: 64 },
                { inFlightSetupCount: 2, maxConcurrentEdgeSetups: 2 }
            ]
        })).toBe('wait');
    });

    it('admits a peer no group bounds', () => {
        expect(computeInFlightDialAdmission({ owningGroupBudgets: [] })).toBe('admit');
    });
});
