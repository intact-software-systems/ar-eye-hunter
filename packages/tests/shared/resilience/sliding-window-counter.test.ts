import { SlidingWindowCounter } from '@shared/resilience/sliding-window-counter.ts';
import { describe, expect, it } from 'vitest';

describe('SlidingWindowCounter', () => {
    it('expires old sliding-window counts outside the active window', () => {
        const counter = SlidingWindowCounter.initWithTs(100, 25, 0);

        SlidingWindowCounter.updateWithNow(counter, 1, 0);
        SlidingWindowCounter.updateWithNow(counter, 2, 20);
        SlidingWindowCounter.updateWithNow(counter, 3, 70);

        expect(SlidingWindowCounter.sumInWindowWithNow(counter, 70)).toBe(6);
        expect(SlidingWindowCounter.sumInWindowWithNow(counter, 150)).toBe(3);
    });
});
