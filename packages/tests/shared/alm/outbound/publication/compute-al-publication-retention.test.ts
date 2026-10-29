import { describe, expect, it } from 'vitest';

import { computeALPublicationRetention } from '@shared/alm/outbound/publication/compute-al-publication-retention.ts';

describe('computeALPublicationRetention', () => {
    it('keeps the first value of an empty stream and displaces nothing', () => {
        expect(computeALPublicationRetention({ retained: [], incoming: 'v1', retainNewest: 1 })).toEqual({
            retained: ['v1'],
            displaced: undefined
        });
    });

    it('displaces the one retained value when the stream keeps only the newest', () => {
        expect(computeALPublicationRetention({ retained: ['v1'], incoming: 'v2', retainNewest: 1 })).toEqual({
            retained: ['v2'],
            displaced: 'v1'
        });
    });

    it('keeps up to the newest three oldest first and then displaces the oldest', () => {
        expect(computeALPublicationRetention({ retained: ['v1', 'v2'], incoming: 'v3', retainNewest: 3 })).toEqual({
            retained: ['v1', 'v2', 'v3'],
            displaced: undefined
        });
        expect(computeALPublicationRetention({ retained: ['v1', 'v2', 'v3'], incoming: 'v4', retainNewest: 3 }))
            .toEqual({ retained: ['v2', 'v3', 'v4'], displaced: 'v1' });
    });
});
