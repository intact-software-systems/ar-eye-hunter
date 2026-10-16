import { describe, expect, it } from 'vitest';

import { startTimerLagSampling, type TimerLagWindow } from '@shared/resilience/start-timer-lag-sampling.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { createManualTimers, type ManualTimers } from './manual-timers.ts';

/** Fires each scheduled timer late by the next listed lateness, as a blocked event loop would. */
function createLateTimers(timers: ManualTimers, latenessMs: readonly number[]): Timers {
    let next = 0;
    return {
        nowMs: () => timers.nowMs(),
        schedule: (run, delayMs) => {
            const lateByMs = latenessMs[next] ?? 0;
            next += 1;
            return timers.schedule(run, delayMs + lateByMs);
        }
    };
}

describe('timer lag sampling', () => {
    it('reports one window of punctual ticks with no lag', async () => {
        const timers = createManualTimers(0);
        const windows: TimerLagWindow[] = [];
        const stop = startTimerLagSampling({
            timers,
            tickIntervalMs: 100,
            windowMs: 1_000,
            onWindow: (window) => windows.push(window)
        });

        await timers.advanceTo(999);
        expect(windows).toEqual([]);
        await timers.advanceTo(1_000);

        expect(windows).toEqual([{ startedAtMs: 0, endedAtMs: 1_000, sampleCount: 10, maxLagMs: 0, p50LagMs: 0 }]);
        stop();
    });

    it('measures how late each tick fires and reports the window maximum and median', async () => {
        const timers = createManualTimers(0);
        const windows: TimerLagWindow[] = [];
        const stop = startTimerLagSampling({
            timers: createLateTimers(timers, [0, 40, 300, 0, 10]),
            tickIntervalMs: 100,
            windowMs: 500,
            onWindow: (window) => windows.push(window)
        });

        // Ticks fire at 100, 240, 640, 740 and 850: lags 0, 40, 300, 0 and 10 ms.
        await timers.advanceTo(850);

        expect(windows).toEqual([
            { startedAtMs: 0, endedAtMs: 640, sampleCount: 3, maxLagMs: 300, p50LagMs: 40 }
        ]);
        stop();
    });

    it('starts the next window where the previous one ended', async () => {
        const timers = createManualTimers(0);
        const windows: TimerLagWindow[] = [];
        const stop = startTimerLagSampling({
            timers: createLateTimers(timers, [0, 0, 0, 25]),
            tickIntervalMs: 100,
            windowMs: 200,
            onWindow: (window) => windows.push(window)
        });

        await timers.advanceTo(425);

        expect(windows).toEqual([
            { startedAtMs: 0, endedAtMs: 200, sampleCount: 2, maxLagMs: 0, p50LagMs: 0 },
            { startedAtMs: 200, endedAtMs: 425, sampleCount: 2, maxLagMs: 25, p50LagMs: 0 }
        ]);
        stop();
    });

    it('stops without reporting the unfinished window and leaves no pending tick', async () => {
        const timers = createManualTimers(0);
        const windows: TimerLagWindow[] = [];
        const stop = startTimerLagSampling({
            timers,
            tickIntervalMs: 100,
            windowMs: 1_000,
            onWindow: (window) => windows.push(window)
        });

        await timers.advanceTo(500);
        stop();
        await timers.advanceTo(5_000);

        expect(windows).toEqual([]);
        expect(timers.pendingCount()).toBe(0);
    });
});
