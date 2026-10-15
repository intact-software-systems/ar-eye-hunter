import { describe, expect, it } from 'vitest';

import { startRepeating } from '@shared/resilience/start-repeating.ts';
import { createManualTimers } from './manual-timers.ts';

describe('repeating run', () => {
    it('runs once per interval after the first interval and stops idempotently', async () => {
        const timers = createManualTimers(0);
        const runs: number[] = [];
        const stop = startRepeating({
            timers,
            intervalMs: 100,
            firstRun: 'after-interval',
            run: () => {
                runs.push(timers.nowMs());
            }
        });

        await timers.advanceTo(99);
        expect(runs).toEqual([]);
        await timers.advanceTo(250);
        expect(runs).toEqual([100, 200]);

        stop();
        stop();
        await timers.advanceTo(1_000);

        expect(runs).toEqual([100, 200]);
        expect(timers.pendingCount()).toBe(0);
    });

    it('runs the first run within the start call when asked, then on the interval', async () => {
        const timers = createManualTimers(0);
        const runs: number[] = [];
        const stop = startRepeating({
            timers,
            intervalMs: 100,
            firstRun: 'now',
            run: () => {
                runs.push(timers.nowMs());
            }
        });

        expect(runs).toEqual([0]);
        await timers.advanceTo(100);
        expect(runs).toEqual([0, 100]);
        stop();
    });

    it('schedules the next run only once an asynchronous run has completed', async () => {
        const timers = createManualTimers(0);
        const finish = Promise.withResolvers<void>();
        const started = Promise.withResolvers<void>();
        let runs = 0;
        const stop = startRepeating({
            timers,
            intervalMs: 100,
            firstRun: 'after-interval',
            run: () => {
                runs += 1;
                started.resolve();
                return finish.promise;
            }
        });

        const advancing = timers.advanceTo(100);
        await started.promise;
        expect(runs).toBe(1);
        expect(timers.pendingCount()).toBe(0);

        finish.resolve();
        await advancing;

        expect(timers.pendingCount()).toBe(1);
        await timers.advanceTo(199);
        expect(runs).toBe(1);
        await timers.advanceTo(200);
        expect(runs).toBe(2);
        stop();
    });

    it('retries a failed run on the failure backoff and resumes the interval after a success', async () => {
        const timers = createManualTimers(0);
        const runs: number[] = [];
        let failuresLeft = 3;
        const stop = startRepeating({
            timers,
            intervalMs: 100,
            retryBackoff: { baseMs: 10, maxMs: 20 },
            firstRun: 'after-interval',
            run: () => {
                runs.push(timers.nowMs());
                if (failuresLeft > 0) {
                    failuresLeft -= 1;
                    return Promise.reject(new Error('sweep failed'));
                }
                return Promise.resolve();
            }
        });

        await timers.advanceTo(400);

        expect(runs).toEqual([100, 110, 130, 150, 250, 350]);
        stop();
    });

    it('without a retry backoff a failed run waits the interval and its failure reaches the timer host', async () => {
        const timers = createManualTimers(0);
        const runs: number[] = [];
        const stop = startRepeating({
            timers,
            intervalMs: 100,
            firstRun: 'after-interval',
            run: () => {
                runs.push(timers.nowMs());
                if (runs.length === 1) {
                    throw new Error('sync failure');
                }
                if (runs.length === 2) {
                    return Promise.reject(new Error('async failure'));
                }
                return undefined;
            }
        });

        await expect(timers.advanceTo(100)).rejects.toThrow('sync failure');
        expect(timers.pendingCount()).toBe(1);
        await expect(timers.advanceTo(200)).rejects.toThrow('async failure');
        await timers.advanceTo(300);

        expect(runs).toEqual([100, 200, 300]);
        stop();
    });

    it('does not reschedule a run that is in flight when stopped', async () => {
        const timers = createManualTimers(0);
        const finish = Promise.withResolvers<void>();
        let started = 0;
        const stop = startRepeating({
            timers,
            intervalMs: 100,
            firstRun: 'now',
            run: () => {
                started += 1;
                return finish.promise;
            }
        });

        expect(started).toBe(1);
        stop();
        finish.resolve();
        await finish.promise;
        await Promise.resolve();

        expect(timers.pendingCount()).toBe(0);
        await timers.advanceTo(1_000);
        expect(started).toBe(1);
    });

    it('rejects an interval that is not a positive finite number', () => {
        const timers = createManualTimers(0);
        expect(() => startRepeating({ timers, intervalMs: 0, firstRun: 'after-interval', run: () => undefined }))
            .toThrow(TypeError);
        expect(() =>
            startRepeating({
                timers,
                intervalMs: Number.POSITIVE_INFINITY,
                firstRun: 'after-interval',
                run: () => undefined
            })
        ).toThrow(TypeError);
    });
});
