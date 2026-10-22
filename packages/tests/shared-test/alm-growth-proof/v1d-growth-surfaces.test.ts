import {
    describe,
    expect,
    it
} from 'vitest';

import {
    V1D_GROWTH_SURFACES,
    V1D_GROWTH_SURVEY_SURFACE_IDS
} from '../../../shared-test/rallar-bb-test/alm/growth-proof/v1d-growth-surfaces.ts';

describe('V1d growth surface classification', () => {
    it('classifies every surface of the growth survey, each with at least one reader', () => {
        const ids = V1D_GROWTH_SURFACES.map((surface) => surface.id);
        const names = V1D_GROWTH_SURFACES.map((surface) => surface.name);

        expect(new Set(names).size).toBe(names.length);
        expect(V1D_GROWTH_SURVEY_SURFACE_IDS).toHaveLength(75);
        expect(V1D_GROWTH_SURVEY_SURFACE_IDS.filter((id) => !ids.includes(id))).toEqual([]);
        expect(V1D_GROWTH_SURFACES.filter((surface) => surface.readers.length === 0)).toEqual([]);
    });

    it('keeps each runtime-state namespace with one surface, so a namespace has one class', () => {
        const namespaces = V1D_GROWTH_SURFACES.flatMap((surface) =>
            surface.readers
                .filter((reader) => reader.source === 'postgres' && reader.path[1] === 'byNamespace')
                .map((reader) => reader.path[2])
        );

        expect(new Set(namespaces).size).toBe(namespaces.length);
    });

    it('guards the resource_inbox total against rows stamped never to expire', () => {
        const total = V1D_GROWTH_SURFACES.find((surface) => surface.id === 1);

        expect(total?.classification.growthClass).toBe('ttl-beyond-run');
        expect(total?.readers).toEqual([{
            source: 'postgres',
            path: ['resourceInbox', 'total'],
            absent: 'zero',
            neverExpiringPath: ['resourceInbox', 'neverExpire']
        }]);
    });

    it('bounds a page\'s delivered markers at 256 per inbound store across its two stores', () => {
        const markers = V1D_GROWTH_SURFACES.find((surface) => surface.id === 49);

        expect(markers?.classification).toEqual({ growthClass: 'count-capped', cap: 512 });
    });
});
