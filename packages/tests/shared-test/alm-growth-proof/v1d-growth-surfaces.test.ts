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
    it('classifies every surface of the growth survey once, each with at least one reader', () => {
        const ids = V1D_GROWTH_SURFACES.map((surface) => surface.id);

        expect(new Set(ids).size).toBe(ids.length);
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
});
