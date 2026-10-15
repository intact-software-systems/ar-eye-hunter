import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultBackgroundTimers, createDefaultTimers } from '@shared/resilience/timers.ts';
import { createManualTimers } from './manual-timers.ts';

describe('default timers', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('reads the wall clock and runs a scheduled callback once after its delay', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const timers = createDefaultTimers();
        const ran: number[] = [];

        expect(timers.nowMs()).toBe(10_000);
        timers.schedule(() => ran.push(timers.nowMs()), 250);
        await vi.advanceTimersByTimeAsync(249);
        expect(ran).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(1_000);

        expect(ran).toEqual([10_250]);
    });

    it('answers a cancel that keeps the callback from running', async () => {
        vi.useFakeTimers();
        const timers = createDefaultTimers();
        let ran = false;

        const cancel = timers.schedule(() => {
            ran = true;
        }, 100);
        cancel();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(ran).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('background timers do not hold the process open', () => {
        let unreferenced = 0;
        vi.stubGlobal('setTimeout', () => ({
            unref: () => {
                unreferenced += 1;
            }
        }));

        createDefaultTimers().schedule(() => undefined, 10);
        expect(unreferenced).toBe(0);
        createDefaultBackgroundTimers().schedule(() => undefined, 10);
        expect(unreferenced).toBe(1);
    });
});

describe('manual timers', () => {
    it('runs due timers earliest first, then in scheduling order, with the clock at each due time', async () => {
        const timers = createManualTimers(1_000);
        const ran: string[] = [];
        timers.schedule(() => ran.push(`b@${timers.nowMs()}`), 200);
        timers.schedule(() => ran.push(`a@${timers.nowMs()}`), 100);
        timers.schedule(() => ran.push(`c@${timers.nowMs()}`), 200);
        timers.schedule(() => ran.push(`d@${timers.nowMs()}`), 500);

        await timers.advanceTo(1_250);

        expect(ran).toEqual(['a@1100', 'b@1200', 'c@1200']);
        expect(timers.nowMs()).toBe(1_250);
        expect(timers.pendingCount()).toBe(1);
        await timers.advance(250);
        expect(ran).toEqual(['a@1100', 'b@1200', 'c@1200', 'd@1500']);
        expect(timers.pendingCount()).toBe(0);
    });

    it('awaits an asynchronous callback and runs what it schedules when due', async () => {
        const timers = createManualTimers(0);
        const ran: string[] = [];
        timers.schedule(async () => {
            await Promise.resolve();
            ran.push('first');
            timers.schedule(() => ran.push('chained'), 10);
        }, 10);

        await timers.advanceTo(20);

        expect(ran).toEqual(['first', 'chained']);
    });

    it('does not run a cancelled timer', async () => {
        const timers = createManualTimers(0);
        let ran = false;
        const cancel = timers.schedule(() => {
            ran = true;
        }, 10);

        cancel();
        await timers.advanceTo(100);

        expect(ran).toBe(false);
    });
});
