import { describe, expect, it, vi } from 'vitest';
import { createRecipeConsoleSeedState } from '../../../apps/rallar-black-box/src/recipe-console/data/seeded-console-state.ts';

describe('Recipe Console seeded state', () => {
    it('keeps synthetic state isolated to Tune after the live Monitor replacement', () => {
        const state = createRecipeConsoleSeedState();

        expect(state).not.toHaveProperty('monitor');
        expect(state).toHaveProperty('tune');
    });

    it('projects only stable command-duration Tune evidence', () => {
        const { tune } = createRecipeConsoleSeedState();

        expect(tune).toMatchObject({
            seedId: 'high-latency-rtc',
            distributedRunId: 'seed-high-latency-rtc',
            controlRunId: 'seed-control-high-latency-rtc',
            state: 'passed',
            rtcTimelineAvailable: false,
        });
        expect(tune.agentMeans.map(row => row.meanMs)).toEqual([112.5, 1010, 1190]);
        expect(tune.percentiles).toEqual({
            p50Ms: 1010,
            p95Ms: 1190,
            p99Ms: 1190,
            maxMs: 1190,
        });
        expect(tune.histogram.map(bucket => bucket.count)).toEqual([1, 0, 0, 2]);
        expect(tune.points).toHaveLength(3);
        expect(tune.matrixCells).toHaveLength(18);
        expect(tune.emptyReasons).toContain('No RTC timeline events yet');
        expect(tune).not.toHaveProperty('diagnostics');
        expect(tune).not.toHaveProperty('performance');
        expect(tune).not.toHaveProperty('timeseries');
        expect(tune).not.toHaveProperty('phaseSpans');
    });

    it('does not leak clock-bearing diagnostics into deterministic models', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime('2026-07-11T08:00:00.000Z');
            const first = createRecipeConsoleSeedState();
            vi.setSystemTime('2036-07-11T08:00:00.000Z');
            const second = createRecipeConsoleSeedState();

            expect(second).toEqual(first);
        } finally {
            vi.useRealTimers();
        }
    });
});
