import { describe, expect, it } from 'vitest';
import { resolveRecipeConsolePresentation } from '../../../apps/rallar-black-box/src/recipe-console/shell/responsive-presentation.ts';

describe('Recipe Console responsive presentation', () => {
    it.each([
        [1440, 900, { navigation: 'rail', inspector: 'rail', commandBarHeight: 52 }],
        [900, 900, { navigation: 'compact-rail', inspector: 'overlay', commandBarHeight: 52 }],
        [430, 932, { navigation: 'bottom', inspector: 'sheet', commandBarHeight: 52 }],
        [932, 430, { navigation: 'compact-rail', inspector: 'overlay', commandBarHeight: 48 }],
    ] as const)('maps %d × %d to the approved shell mode', (width, height, expected) => {
        expect(resolveRecipeConsolePresentation(width, height)).toEqual(expected);
    });
});
