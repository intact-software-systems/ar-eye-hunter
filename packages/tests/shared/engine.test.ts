import { describe, expect, it, vi } from 'vitest';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

describe('engine', () => {
    it('executes a task once when work is available', async () => {
        vi.useFakeTimers();
        try {
            const engine = new InboxOutboxEngine();
            let remainingWork = 1;
            let runCount = 0;

            engine.includeTask(
                'test-task',
                {
                    name: 'test-task',
                    maxConcurrency: () => 1,
                    isWork: () => remainingWork > 0,
                    runnable: async () => {
                        runCount += 1;
                        remainingWork -= 1;
                    },
                    ongoingTasks: [],
                },
            );

            const firstRunPromise = engine.executeOnce();
            await vi.runAllTimersAsync();
            const firstRun = await firstRunPromise;

            const secondRunPromise = engine.executeOnce();
            await vi.runAllTimersAsync();
            const secondRun = await secondRunPromise;

            expect(firstRun).toBe(true);
            expect(secondRun).toBe(false);
            expect(runCount).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
