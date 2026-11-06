import { describe, expect, it } from 'vitest';

import { startDrainableRepeating } from '@shared/resilience/timing/start-drainable-repeating.ts';
import { createManualTimers } from '../manual-timers.ts';

describe('drainable repeating run', () => {
    it('aborts and drains the run in flight at stop, then schedules nothing', async () => {
        const timers = createManualTimers(0);
        const held = Promise.withResolvers<void>();
        const signals: AbortSignal[] = [];
        let settled = false;
        const stop = startDrainableRepeating({
            timers,
            intervalMs: 100,
            firstRun: 'now',
            retryBackoff: { baseMs: 100, maxMs: 400 },
            onFailure: () => undefined,
            run: async (stopping) => {
                signals.push(stopping);
                await held.promise;
                settled = true;
            }
        });
        const stopped = stop();
        expect(signals[0].aborted).toBe(true);
        held.resolve();
        await stopped;
        expect(settled).toBe(true);
        await timers.advanceTo(1_000);
        expect(signals).toHaveLength(1);
        expect(timers.pendingCount()).toBe(0);
    });

    it('reports each failure once, backs off, and resolves stop without reporting the drained failure again', async () => {
        const timers = createManualTimers(0);
        const failures: string[] = [];
        const runs: number[] = [];
        const stop = startDrainableRepeating({
            timers,
            intervalMs: 100,
            firstRun: 'after-interval',
            retryBackoff: { baseMs: 300, maxMs: 600 },
            onFailure: (error) => failures.push(error.message),
            run: async () => {
                runs.push(timers.nowMs());
                throw new Error(`failed at ${timers.nowMs()}`);
            }
        });
        await timers.advanceTo(100);
        await timers.advanceTo(399);
        expect(runs).toEqual([100]);
        await timers.advanceTo(400);
        expect(runs).toEqual([100, 400]);
        await stop();
        expect(failures).toEqual(['failed at 100', 'failed at 400']);
    });
});
