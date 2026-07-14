import { describe, expect, it, vi } from 'vitest';
import { resolveRecipeConsolePresentation } from '../../../apps/rallar-black-box/src/recipe-console/shell/responsive-presentation.ts';
import { createViewportSubscriptionStore } from '../../../apps/rallar-black-box/src/recipe-console/shell/use-responsive-presentation.ts';

describe('Recipe Console responsive presentation', () => {
    it.each([
        [1440, 900, { navigation: 'rail', inspector: 'rail', commandBarHeight: 52 }],
        [900, 900, { navigation: 'compact-rail', inspector: 'overlay', commandBarHeight: 52 }],
        [430, 932, { navigation: 'bottom', inspector: 'sheet', commandBarHeight: 52 }],
        [932, 430, { navigation: 'compact-rail', inspector: 'overlay', commandBarHeight: 48 }],
    ] as const)('maps %d × %d to the approved shell mode', (width, height, expected) => {
        expect(resolveRecipeConsolePresentation(width, height)).toEqual(expected);
    });

    it('deduplicates viewport listeners and cleans them up after the final subscriber', () => {
        const resizeListeners = new Set<() => void>();
        const mediaListeners = new Set<() => void>();
        const port = {
            width: () => 900,
            height: () => 900,
            addResizeListener: vi.fn((listener: () => void) => resizeListeners.add(listener)),
            removeResizeListener: vi.fn((listener: () => void) => resizeListeners.delete(listener)),
            addOrientationListener: vi.fn((listener: () => void) => mediaListeners.add(listener)),
            removeOrientationListener: vi.fn((listener: () => void) => mediaListeners.delete(listener)),
        };
        const store = createViewportSubscriptionStore(port);
        const first = vi.fn();
        const second = vi.fn();
        const unsubscribeFirst = store.subscribe(first);
        const unsubscribeSecond = store.subscribe(second);

        expect(port.addResizeListener).toHaveBeenCalledTimes(1);
        expect(port.addOrientationListener).toHaveBeenCalledTimes(1);
        expect(store.snapshot()).toBe('900:900');
        resizeListeners.forEach(listener => listener());
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);

        unsubscribeFirst();
        expect(port.removeResizeListener).not.toHaveBeenCalled();
        unsubscribeSecond();
        expect(port.removeResizeListener).toHaveBeenCalledTimes(1);
        expect(port.removeOrientationListener).toHaveBeenCalledTimes(1);
        expect(resizeListeners.size).toBe(0);
        expect(mediaListeners.size).toBe(0);
    });
});
