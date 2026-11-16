import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { createBrowserQueueBoxEngine } from '@shared-web/browser/queuebox/create-browser-queue-box-engine.ts';

describe('createBrowserQueueBoxEngine', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('starts scheduled queue work before returning the engine', async () => {
        vi.useFakeTimers();

        const engine = createBrowserQueueBoxEngine(Date.now);

        expect(vi.getTimerCount()).toBe(1);
        await engine.stop();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([-20_000, 20_000])('schedules server-epoch work despite a device offset of %i ms', async (offset) => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000 + offset);
        const nowEpochMs = (): number => 1_000_000 + Math.floor(performance.now());
        const engine = createBrowserQueueBoxEngine(nowEpochMs);
        onTestFinished(() => engine.stop());
        // Let idle backoff grow so the requested deadline must advance the next pass.
        for (let pass = 0; pass < 10; pass += 1) {
            await vi.advanceTimersToNextTimerAsync();
        }
        const readyAtMs = nowEpochMs() + 250;
        const probes: number[] = [];
        engine.includeTask('server-deadline', {
            name: 'server-deadline',
            maxConcurrency: () => 1,
            isWork: async () => {
                probes.push(nowEpochMs());
                return false;
            },
            runnable: async () => {},
            ongoingTasks: []
        });
        engine.wakeAt('server-deadline', readyAtMs);
        await vi.advanceTimersToNextTimerAsync();
        expect(probes).toEqual([readyAtMs]);
    });
});
