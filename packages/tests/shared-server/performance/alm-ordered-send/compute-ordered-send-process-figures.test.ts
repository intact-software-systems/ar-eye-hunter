import { describe, expect, it } from 'vitest';

import { computeOrderedSendProcessFigures } from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/compute-ordered-send-process-figures.ts';

describe('computeOrderedSendProcessFigures', () => {
    it('ranks the lags of the timer\'s ticks by nearest rank and gives the share of ticks more than 1 ms late', () => {
        const figures = computeOrderedSendProcessFigures({
            startedAtMs: 1_000,
            endedAtMs: 1_100.5,
            cpuAtStart: { userMicros: 0, systemMicros: 0 },
            cpuAtEnd: { userMicros: 0, systemMicros: 0 },
            loopLagsMs: [0.2, 0.4, 0.1, 3, 12, 0.9, 1, 1.1, 0.3, 0.5]
        });

        // Ascending: 0.1, 0.2, 0.3, 0.4, 0.5, 0.9, 1, 1.1, 3, 12. Three of the ten ticks are more than 1 ms late.
        expect(figures.loopLag).toEqual({
            ticks: 10,
            p50Ms: 0.5,
            p95Ms: 12,
            p99Ms: 12,
            maxMs: 12,
            shareOfTicksOverOneMsLate: 0.3
        });
        expect(figures.wallMs).toBe(100.5);
    });

    it('gives the processor time the whole process used over the span, says so, and how many cores that kept busy', () => {
        const figures = computeOrderedSendProcessFigures({
            startedAtMs: 500,
            endedAtMs: 20_500,
            cpuAtStart: { userMicros: 3_000_000, systemMicros: 400_000 },
            cpuAtEnd: { userMicros: 11_000_000, systemMicros: 2_400_000 },
            loopLagsMs: [0]
        });

        expect(figures.cpu).toEqual({
            scope: 'whole process, every thread',
            userMs: 8_000,
            systemMs: 2_000,
            coresBusy: 0.5
        });
    });

    it('gives no lag figure over no tick and no busy cores over a span of no length', () => {
        const figures = computeOrderedSendProcessFigures({
            startedAtMs: 700,
            endedAtMs: 700,
            cpuAtStart: { userMicros: 5, systemMicros: 5 },
            cpuAtEnd: { userMicros: 5, systemMicros: 5 },
            loopLagsMs: []
        });

        expect(figures).toEqual({
            wallMs: 0,
            loopLag: { ticks: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null, shareOfTicksOverOneMsLate: null },
            cpu: { scope: 'whole process, every thread', userMs: 0, systemMs: 0, coresBusy: null }
        });
    });
});
