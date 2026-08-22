import { describe, expect, it } from 'vitest';

import { nextRovingNavigationIndex, type RovingNavigationKey } from '../../../apps/rallar-black-box/src/recipe-console/app/navigation-keyboard.ts';

describe('Recipe Console roving navigation index', () => {
    it.each<RovingNavigationKey>(['ArrowLeft', 'ArrowUp'])(
        'moves one item backward for %s and wraps from first to last',
        (key) => {
            expect(nextRovingNavigationIndex(2, key, 4)).toBe(1);
            expect(nextRovingNavigationIndex(0, key, 4)).toBe(3);
        }
    );

    it.each<RovingNavigationKey>(['ArrowRight', 'ArrowDown'])(
        'moves one item forward for %s and wraps from last to first',
        (key) => {
            expect(nextRovingNavigationIndex(1, key, 4)).toBe(2);
            expect(nextRovingNavigationIndex(3, key, 4)).toBe(0);
        }
    );

    it('moves Home to the first item and End to the last item', () => {
        expect(nextRovingNavigationIndex(2, 'Home', 4)).toBe(0);
        expect(nextRovingNavigationIndex(2, 'End', 4)).toBe(3);
    });

    it.each<RovingNavigationKey>([
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Home',
        'End'
    ])('returns zero for %s when there are no items', (key) => {
        expect(nextRovingNavigationIndex(3, key, 0)).toBe(0);
        expect(nextRovingNavigationIndex(3, key, -2)).toBe(0);
    });

    it('normalizes out-of-range integer positions before applying arrow movement', () => {
        expect(nextRovingNavigationIndex(6, 'ArrowRight', 4)).toBe(3);
        expect(nextRovingNavigationIndex(6, 'ArrowLeft', 4)).toBe(1);
        expect(nextRovingNavigationIndex(-1, 'ArrowRight', 4)).toBe(0);
        expect(nextRovingNavigationIndex(-1, 'ArrowLeft', 4)).toBe(2);
        expect(nextRovingNavigationIndex(-6, 'ArrowRight', 4)).toBe(3);
        expect(nextRovingNavigationIndex(-6, 'ArrowLeft', 4)).toBe(1);
    });
});
