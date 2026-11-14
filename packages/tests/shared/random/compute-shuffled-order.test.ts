import { describe, expect, it } from 'vitest';

import { computeShuffledOrder } from '@shared/random/compute-shuffled-order.ts';

const ITEMS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;

describe('computeShuffledOrder', () => {
    it('gives one order per seed, so a recorded seed replays its run', () => {
        expect(computeShuffledOrder(ITEMS, 101)).toEqual(['a', 'e', 'c', 'h', 'g', 'd', 'f', 'b']);
        expect(computeShuffledOrder(ITEMS, 4_242)).toEqual(['g', 'd', 'a', 'h', 'c', 'f', 'b', 'e']);
    });

    it('leaves its input as it was', () => {
        const items = [...ITEMS];
        computeShuffledOrder(items, 101);
        expect(items).toEqual([...ITEMS]);
    });
});
