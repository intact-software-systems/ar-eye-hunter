import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PacedEmit } from '../../../apps/rallar-black-box/src/app/paced-emit.ts';

function createCountedPacedEmit(intervalMs: number): { readonly paced: PacedEmit; readonly emits: () => number; } {
    let emits = 0;
    return {
        paced: new PacedEmit(intervalMs, () => {
            emits += 1;
        }),
        emits: () => emits
    };
}

describe('PacedEmit', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('emits once at the end of an interval however often it was requested within it', () => {
        const { paced, emits } = createCountedPacedEmit(100);

        paced.request();
        vi.advanceTimersByTime(40);
        paced.request();
        paced.request();
        expect(emits()).toBe(0);

        vi.advanceTimersByTime(60);
        expect(emits()).toBe(1);
    });

    it('starts a new interval with the first request after an emit, and emits nothing unrequested', () => {
        const { paced, emits } = createCountedPacedEmit(100);

        paced.request();
        vi.advanceTimersByTime(600);
        expect(emits()).toBe(1);

        paced.request();
        vi.advanceTimersByTime(99);
        expect(emits()).toBe(1);
        vi.advanceTimersByTime(1);
        expect(emits()).toBe(2);
    });
});
