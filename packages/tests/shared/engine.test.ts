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

    it('does not treat idle executions as circuit breaker failures', async () => {
        vi.useFakeTimers();
        try {
            const engine = new InboxOutboxEngine();
            let remainingWork = 0;
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

            for (let i = 0; i < 20; i++) {
                expect(await executeOnceWithTimers(engine)).toBe(false);
            }

            remainingWork = 1;

            expect(await executeOnceWithTimers(engine)).toBe(true);
            expect(runCount).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('preserves in-flight task state between executions', async () => {
        vi.useFakeTimers();
        try {
            const engine = new InboxOutboxEngine();
            let releaseTask!: () => void;
            const taskGate = new Promise<void>((resolve) => {
                releaseTask = resolve;
            });
            let remainingWork = 2;
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
                        await taskGate;
                    },
                    ongoingTasks: [],
                },
            );

            expect(await executeOnceWithTimers(engine)).toBe(true);
            expect(runCount).toBe(1);
            expect(remainingWork).toBe(1);

            expect(await executeOnceWithTimers(engine)).toBe(false);
            expect(runCount).toBe(1);
            expect(remainingWork).toBe(1);

            releaseTask();
            await vi.runAllTimersAsync();

            expect(await executeOnceWithTimers(engine)).toBe(true);
            expect(runCount).toBe(2);
            expect(remainingWork).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not reschedule after stop during an active execution', async () => {
        vi.useFakeTimers();
        try {
            const engine = new InboxOutboxEngine();
            let resolveIsWork!: (value: boolean) => void;
            const isWorkGate = new Promise<boolean>((resolve) => {
                resolveIsWork = resolve;
            });
            let resolveIsWorkStarted!: () => void;
            const isWorkStarted = new Promise<void>((resolve) => {
                resolveIsWorkStarted = resolve;
            });
            let isWorkCalls = 0;

            engine.includeTask(
                'test-task',
                {
                    name: 'test-task',
                    maxConcurrency: () => 1,
                    isWork: async () => {
                        isWorkCalls += 1;
                        resolveIsWorkStarted();
                        return await isWorkGate;
                    },
                    runnable: async () => undefined,
                    ongoingTasks: [],
                },
            );

            engine.start();
            await vi.advanceTimersByTimeAsync(0);
            await isWorkStarted;

            engine.stop();
            resolveIsWork(false);
            await vi.runAllTimersAsync();

            const callsAfterStoppedRun = isWorkCalls;
            await vi.advanceTimersByTimeAsync(60_000);

            expect(isWorkCalls).toBe(callsAfterStoppedRun);
        } finally {
            vi.useRealTimers();
        }
    });

    it('wakes an idle scheduled engine when work is enqueued', async () => {
        vi.useFakeTimers();
        try {
            const engine = new InboxOutboxEngine();
            let remainingWork = 0;
            let isWorkCalls = 0;
            let runCount = 0;

            engine.includeTask(
                'test-task',
                {
                    name: 'test-task',
                    maxConcurrency: () => 1,
                    isWork: () => {
                        isWorkCalls += 1;
                        return remainingWork > 0;
                    },
                    runnable: async () => {
                        runCount += 1;
                        remainingWork -= 1;
                    },
                    ongoingTasks: [],
                },
            );

            engine.start();
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(10);

            const idleChecks = isWorkCalls;
            remainingWork = 1;
            engine.wake();

            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(10);

            expect(isWorkCalls).toBeGreaterThan(idleChecks);
            expect(runCount).toBe(1);

            engine.stop();
        } finally {
            vi.useRealTimers();
        }
    });
});

async function executeOnceWithTimers(
    engine: InboxOutboxEngine,
): Promise<boolean> {
    const runPromise = engine.executeOnce();
    await vi.runAllTimersAsync();

    return await runPromise;
}
