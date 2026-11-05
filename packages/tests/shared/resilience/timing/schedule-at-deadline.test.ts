import { describe, expect, it } from 'vitest';

import { scheduleAtDeadline } from '@shared/resilience/timing/schedule-at-deadline.ts';
import { createManualTimers } from '../manual-timers.ts';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

describe('deadline timer', () => {
    it('runs once at a near deadline and immediately for a past one', async () => {
        const timers = createManualTimers(1_000);
        const runs: number[] = [];
        scheduleAtDeadline(timers, 1_500, () => {
            runs.push(timers.nowMs());
        });
        scheduleAtDeadline(timers, 0, () => {
            runs.push(timers.nowMs());
        });
        await timers.advanceTo(10_000);
        expect(runs).toEqual([1_000, 1_500]);
        expect(timers.pendingCount()).toBe(0);
    });

    it('re-arms a deadline beyond the native delay limit instead of firing early', async () => {
        const timers = createManualTimers(0);
        const deadline = MAX_TIMER_DELAY_MS * 2 + 5;
        const runs: number[] = [];
        scheduleAtDeadline(timers, deadline, () => {
            runs.push(timers.nowMs());
        });
        await timers.advanceTo(MAX_TIMER_DELAY_MS * 2);
        expect(runs).toEqual([]);
        await timers.advanceTo(deadline);
        expect(runs).toEqual([deadline]);
    });

    it('cancels the currently armed step', async () => {
        const timers = createManualTimers(0);
        const runs: number[] = [];
        const cancel = scheduleAtDeadline(timers, MAX_TIMER_DELAY_MS + 10, () => {
            runs.push(timers.nowMs());
        });
        await timers.advanceTo(MAX_TIMER_DELAY_MS);
        cancel();
        await timers.advanceTo(MAX_TIMER_DELAY_MS * 3);
        expect(runs).toEqual([]);
        expect(timers.pendingCount()).toBe(0);
    });
});
