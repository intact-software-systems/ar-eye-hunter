import {
    describe,
    expect,
    it
} from 'vitest';

import { LatestValueTimer } from '@shared/resilience/timing/latest-value-timer.ts';
import { createManualTimers } from '../manual-timers.ts';

describe('LatestValueTimer', () => {
    it('emits once at the deadline and consumes its pending value', async () => {
        const timers = createManualTimers(0);
        const timer = new LatestValueTimer<number>(timers);
        const emitted: number[] = [];
        timer.schedule(1, 100, (value) => emitted.push(value));
        await timers.advance(99);
        expect(emitted).toEqual([]);
        expect(timer.getPending()).toBe(1);
        await timers.advance(1);
        expect(emitted).toEqual([1]);
        expect(timer.getPending()).toBeUndefined();
        await timers.advance(100);
        expect(emitted).toEqual([1]);
    });

    it('discards cancelled work without flushing and permits a fresh deadline', async () => {
        const timers = createManualTimers(0);
        const timer = new LatestValueTimer<number>(timers);
        const emitted: number[] = [];
        timer.schedule(1, 100, (value) => emitted.push(value));
        timer.cancel();
        expect(timer.getPending()).toBeUndefined();
        expect(timers.pendingCount()).toBe(0);
        await timers.advance(200);
        expect(emitted).toEqual([]);
        timer.schedule(2, 20, (value) => emitted.push(value));
        await timers.advance(20);
        expect(emitted).toEqual([2]);
    });

    it('replaces pending values without postponing the first deadline', async () => {
        const timers = createManualTimers(0);
        const timer = new LatestValueTimer<number>(timers);
        const emitted: number[] = [];
        timer.schedule(1, 100, (value) => emitted.push(value));
        await timers.advance(60);
        timer.schedule(2, 100, (value) => emitted.push(value));
        await timers.advance(39);
        expect(emitted).toEqual([]);
        await timers.advance(1);
        expect(emitted).toEqual([2]);
        expect(timers.pendingCount()).toBe(0);
        await timers.advance(100);
        expect(emitted).toEqual([2]);
    });

    it('allows the emitter to schedule another value on a new deadline', async () => {
        const timers = createManualTimers(0);
        const timer = new LatestValueTimer<number>(timers);
        const emitted: number[] = [];
        timer.schedule(1, 10, (value) => {
            emitted.push(value);
            timer.schedule(2, 10, (next) => emitted.push(next));
        });
        await timers.advance(10);
        expect(emitted).toEqual([1]);
        expect(timer.getPending()).toBe(2);
        await timers.advance(10);
        expect(emitted).toEqual([1, 2]);
    });

    it('does not serialize independent asynchronous effects started by emitters', async () => {
        const timers = createManualTimers(0);
        const timer = new LatestValueTimer<number>(timers);
        const first = Promise.withResolvers<void>();
        const started: number[] = [];
        const finished: number[] = [];
        timer.schedule(1, 10, async (value) => {
            started.push(value);
            await first.promise;
            finished.push(value);
        });
        await timers.advance(10);
        timer.schedule(2, 10, (value) => {
            started.push(value);
            finished.push(value);
        });
        await timers.advance(10);
        expect(started).toEqual([1, 2]);
        expect(finished).toEqual([2]);
        first.resolve();
        await first.promise;
        expect(finished).toEqual([2, 1]);
    });
});
