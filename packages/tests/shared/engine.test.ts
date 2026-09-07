import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.useRealTimers();
});

describe('engine', () => {
    it('wakes for a registered task deadline before idle backoff elapses', async () => {
        vi.useFakeTimers();
        const engine = new InboxOutboxEngine();
        const dueAt = Date.now() + 20;
        const ranAt: number[] = [];
        engine.includeTask('receipt', {
            name: 'receipt',
            maxConcurrency: () => 1,
            isWork: () => ranAt.length === 0 && Date.now() >= dueAt,
            runnable: () => {
                ranAt.push(Date.now());
            },
            ongoingTasks: []
        });
        engine.start();
        await vi.advanceTimersByTimeAsync(0);
        engine.wakeAt('receipt', dueAt);
        await vi.advanceTimersByTimeAsync(19);
        expect(ranAt).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(ranAt).toEqual([dueAt]);
        engine.stop();
    });

    it('shares an active pass between scheduled and manual execution without duplicating work', async () => {
        vi.useFakeTimers();
        const engine = new InboxOutboxEngine();
        const observed = Promise.withResolvers<void>();
        const available = Promise.withResolvers<boolean>();
        const submitted = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let checks = 0;
        let runs = 0;
        engine.includeTask('send', {
            name: 'send',
            maxConcurrency: () => 1,
            isWork: async () => {
                checks += 1;
                observed.resolve();
                return available.promise;
            },
            runnable: async () => {
                runs += 1;
                submitted.resolve();
                await release.promise;
            },
            ongoingTasks: []
        });
        engine.start();
        await vi.advanceTimersByTimeAsync(0);
        await observed.promise;
        const manual = engine.executeOnce();
        available.resolve(true);
        await manual;
        await submitted.promise;
        engine.stop();
        release.resolve();
        await vi.runAllTimersAsync();
        expect(checks).toBe(1);
        expect(runs).toBe(1);
    });

    it.each(['remove', 'replace', 'stop'] as const)('does not submit an old task after %s while readiness is pending', async (change) => {
        vi.useFakeTimers();
        const engine = new InboxOutboxEngine();
        const observed = Promise.withResolvers<void>();
        const available = Promise.withResolvers<boolean>();
        let oldRuns = 0;
        let newRuns = 0;
        let remaining = 1;
        engine.includeTask('send', {
            name: 'send',
            maxConcurrency: () => 1,
            isWork: async () => {
                observed.resolve();
                return oldRuns === 0 && await available.promise;
            },
            runnable: async () => {
                oldRuns += 1;
            },
            ongoingTasks: []
        });
        const pending = engine.executeOnce();
        await observed.promise;
        if (change === 'remove') {
            engine.excludeTask('send');
        }
        else if (change === 'stop') {
            engine.stop();
        }
        else {
            engine.includeTask('send', {
                name: 'send',
                maxConcurrency: () => 1,
                isWork: () => remaining > 0,
                runnable: async () => {
                    remaining -= 1;
                    newRuns += 1;
                },
                ongoingTasks: []
            });
        }
        available.resolve(true);
        await pending;
        if (change !== 'stop') {
            await engine.executeOnce();
        }
        expect(oldRuns).toBe(0);
        expect(newRuns).toBe(change === 'replace' ? 1 : 0);
    });

    it('fences a removed task whose executor has not invoked its runnable yet', async () => {
        const engine = new InboxOutboxEngine();
        const scheduled = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const completed = Promise.withResolvers<void>();
        let runs = 0;
        engine.includeTask('send', {
            name: 'send',
            maxConcurrency: () => 1,
            isWork: () => true,
            runnable: async () => {
                runs += 1;
            },
            executor: async (runnable) => {
                scheduled.resolve();
                await release.promise;
                await runnable();
                completed.resolve();
            },
            ongoingTasks: []
        });
        await engine.executeOnce();
        await scheduled.promise;
        engine.excludeTask('send');
        release.resolve();
        await completed.promise;
        await engine.executeOnce();
        expect(runs).toBe(0);
    });

    it('owns task state under its registration id without changing the supplied task', async () => {
        const engine = new InboxOutboxEngine();
        let runs = 0;
        const ongoingTasks = Object.freeze([]);
        const task = Object.freeze({
            name: 'diagnostic-label',
            maxConcurrency: () => 1,
            isWork: () => runs === 0,
            runnable: async () => {
                runs += 1;
            },
            ongoingTasks
        });
        engine.includeTask('send', task);
        await engine.executeOnce();
        expect(engine.excludeTask('send')).toBe(true);
        expect(engine.excludeTask('diagnostic-label')).toBe(false);
        await engine.executeOnce();
        expect(runs).toBe(1);
        expect(task.ongoingTasks).toBe(ongoingTasks);
        expect(task.name).toBe('diagnostic-label');
    });

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
                    ongoingTasks: []
                }
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
        }
        finally {
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
                    ongoingTasks: []
                }
            );

            for (let i = 0; i < 20; i++) {
                expect(await executeOnceWithTimers(engine)).toBe(false);
            }

            remainingWork = 1;

            expect(await executeOnceWithTimers(engine)).toBe(true);
            expect(runCount).toBe(1);
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('preserves in-flight task state between executions', async () => {
        vi.useFakeTimers();
        try {
            const engine = new InboxOutboxEngine();
            const taskGate = Promise.withResolvers<void>();
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
                        await taskGate.promise;
                    },
                    ongoingTasks: []
                }
            );

            expect(await executeOnceWithTimers(engine)).toBe(true);
            expect(runCount).toBe(1);
            expect(remainingWork).toBe(1);

            expect(await executeOnceWithTimers(engine)).toBe(false);
            expect(runCount).toBe(1);
            expect(remainingWork).toBe(1);

            taskGate.resolve();
            await vi.runAllTimersAsync();

            expect(await executeOnceWithTimers(engine)).toBe(true);
            expect(runCount).toBe(2);
            expect(remainingWork).toBe(0);
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('does not reschedule after stop during an active execution', async () => {
        vi.useFakeTimers();
        try {
            const engine = new InboxOutboxEngine();
            const isWorkGate = Promise.withResolvers<boolean>();
            const isWorkStarted = Promise.withResolvers<void>();
            let isWorkCalls = 0;

            engine.includeTask(
                'test-task',
                {
                    name: 'test-task',
                    maxConcurrency: () => 1,
                    isWork: async () => {
                        isWorkCalls += 1;
                        isWorkStarted.resolve();
                        return await isWorkGate.promise;
                    },
                    runnable: async () => undefined,
                    ongoingTasks: []
                }
            );

            engine.start();
            await vi.advanceTimersByTimeAsync(0);
            await isWorkStarted.promise;

            engine.stop();
            isWorkGate.resolve(false);
            await vi.runAllTimersAsync();

            const callsAfterStoppedRun = isWorkCalls;
            await vi.advanceTimersByTimeAsync(60_000);

            expect(isWorkCalls).toBe(callsAfterStoppedRun);
        }
        finally {
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
                    ongoingTasks: []
                }
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
        }
        finally {
            vi.useRealTimers();
        }
    });
});

async function executeOnceWithTimers(
    engine: InboxOutboxEngine
): Promise<boolean> {
    const runPromise = engine.executeOnce();
    await vi.runAllTimersAsync();

    return await runPromise;
}
