import { describe, expect, it } from 'vitest';

import { createSeededRandom } from '@shared/random/create-seeded-random.ts';

describe('createSeededRandom', () => {
    it('gives the same first values for a seed on every machine', () => {
        const random = createSeededRandom(101);
        expect([random(), random(), random(), random()]).toEqual([
            0.1356478596571833,
            0.764801949961111,
            0.5406083094421774,
            0.6430164149496704
        ]);
    });
});
