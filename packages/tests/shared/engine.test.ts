import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { TrackedTask } from '@shared/resilience/ComputeAsyncTask.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

beforeEach(() =>
    onTestFinished(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    })
);

describe('engine', () => {
    it.each(['readiness', 'concurrency'] as const)('recovers from eleven %s failures using only its supplied clock', async (port) => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        let nowEpochMs = 10_000;
        const engine = new InboxOutboxEngine({
            nowEpochMs: () => nowEpochMs,
            random: () => 0.5,
            reportTaskFailure: () => undefined
        });
        onTestFinished(() => engine.stop());
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        engine.includeTask('owned', {
            name: 'owned',
            maxConcurrency: () => {
                if (port === 'concurrency') {
                    throw 'registered pass unavailable';
                }
                return 1;
            },
            isWork: () => {
                throw 'registered pass unavailable';
            },
            runnable: () => {},
            ongoingTasks: []
        });
        for (let attempt = 0; attempt < 11; attempt += 1) {
            expect(await engine.executeOnce()).toBe(false);
        }
        expect(consoleError).toHaveBeenCalledWith('TaskEngine error', expect.any(Error));
        expect(consoleError).toHaveBeenCalledWith('TaskEngine error', expect.objectContaining({ message: 'registered pass unavailable' }));
        let runs = 0;
        engine.includeTask('owned', {
            name: 'replacement',
            maxConcurrency: () => 1,
            isWork: () => runs === 0,
            runnable: () => {
                runs += 1;
            },
            ongoingTasks: []
        });
        nowEpochMs = 20_000;
        expect(await engine.executeOnce()).toBe(false);
        expect(runs).toBe(0);
        nowEpochMs = 20_001;
        expect(await engine.executeOnce()).toBe(true);
        expect(runs).toBe(1);
    });

    it('restarts the supplied-clock reset period after a failed half-open pass', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        let nowEpochMs = 10_000;
        const engine = new InboxOutboxEngine({
            nowEpochMs: () => nowEpochMs,
            random: () => 0.5,
            reportTaskFailure: () => undefined
        });
        onTestFinished(() => engine.stop());
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        let failure = new Error('initial readiness failure');
        engine.includeTask('owned', {
            name: 'owned',
            maxConcurrency: () => 1,
            isWork: () => {
                throw failure;
            },
            runnable: () => {},
            ongoingTasks: []
        });
        for (let attempt = 0; attempt < 11; attempt += 1) {
            expect(await engine.executeOnce()).toBe(false);
        }
        nowEpochMs = 20_001;
        failure = new Error('half-open readiness failure');
        expect(await engine.executeOnce()).toBe(false);
        expect(consoleError).toHaveBeenCalledWith('TaskEngine error', failure);
        let runs = 0;
        engine.includeTask('owned', {
            name: 'replacement',
            maxConcurrency: () => 1,
            isWork: () => runs === 0,
            runnable: () => {
                runs += 1;
            },
            ongoingTasks: []
        });
        nowEpochMs = 30_001;
        expect(await engine.executeOnce()).toBe(false);
        expect(runs).toBe(0);
        nowEpochMs = 30_002;
        expect(await engine.executeOnce()).toBe(true);
        expect(runs).toBe(1);
    });

    it('observes a retained completion once when its registration is replaced', async () => {
        const engine = new InboxOutboxEngine();
        const completion = Promise.withResolvers<void>();
        const failure = new Error('retained completion failed');
        const ongoing = new TrackedTask(completion.promise);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const task = {
            name: 'owned',
            maxConcurrency: () => 1,
            isWork: () => false,
            runnable: () => {},
            ongoingTasks: [ongoing]
        };
        engine.includeTask('owned', task);
        engine.includeTask('owned', task);
        completion.reject(failure);
        await new Promise<void>((resolve) => setImmediate(resolve));
        engine.includeTask('owned', task);
        await new Promise<void>((resolve) => setImmediate(resolve));
        await engine.stop();

        expect(consoleError.mock.calls).toEqual([['Queue engine owned task failed', 'owned', failure]]);
    });

    it('reports a settled runnable failure once before stop without an unhandled rejection', async () => {
        const engine = new InboxOutboxEngine();
        const failure = new Error('registered runnable failed');
        const unhandled: Error[] = [];
        const onUnhandled = (error: unknown) => unhandled.push(toError(error));
        process.on('unhandledRejection', onUnhandled);
        onTestFinished(() => {
            process.off('unhandledRejection', onUnhandled);
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        let available = true;
        let released = false;
        engine.includeTask('owned', {
            name: 'owned',
            maxConcurrency: () => 1,
            isWork: () => available,
            runnable: async () => {
                available = false;
                try {
                    throw failure;
                }
                finally {
                    released = true;
                }
            },
            ongoingTasks: []
        });

        await engine.executeOnce();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(consoleError.mock.calls).toEqual([['Queue engine owned task failed', 'owned', failure]]);
        await engine.stop();

        expect(released).toBe(true);
        expect(unhandled).toEqual([]);
        expect(consoleError.mock.calls).toEqual([['Queue engine owned task failed', 'owned', failure]]);
    });

    it('reports a failure-sink exception without creating an unhandled task rejection', async () => {
        const failure = new Error('owned task failed');
        const reporterFailure = new Error('failure sink refused');
        const reports: Error[] = [];
        const engine = new InboxOutboxEngine({
            nowEpochMs: () => Date.now(),
            random: () => 0.5,
            reportTaskFailure: (_taskId, error) => {
                reports.push(error);
                throw reporterFailure;
            }
        });
        const unhandled: Error[] = [];
        const onUnhandled = (error: unknown) => unhandled.push(toError(error));
        process.on('unhandledRejection', onUnhandled);
        onTestFinished(() => {
            process.off('unhandledRejection', onUnhandled);
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        let available = true;
        engine.includeTask('owned', {
            name: 'owned',
            maxConcurrency: () => 1,
            isWork: () => available,
            runnable: () => {
                available = false;
                throw failure;
            },
            ongoingTasks: []
        });
        await engine.executeOnce();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await engine.stop();

        expect(unhandled).toEqual([]);
        expect(reports).toEqual([failure]);
        expect(consoleError.mock.calls).toEqual([
            ['Queue engine owned task failed', 'owned', expect.any(AggregateError)]
        ]);
        const reported = consoleError.mock.calls[0]?.[2];
        if (!(reported instanceof AggregateError)) {
            throw new Error('Expected an owned reporting failure');
        }
        expect(reported.errors).toEqual([failure, reporterFailure]);
    });

    it('joins failing runnable cleanup during stop and reports the owned failure once', async () => {
        const engine = new InboxOutboxEngine();
        const failure = new Error('owned computation failed during shutdown');
        const unhandled: Error[] = [];
        const onUnhandled = (error: unknown) => unhandled.push(toError(error));
        process.on('unhandledRejection', onUnhandled);
        onTestFinished(() => {
            process.off('unhandledRejection', onUnhandled);
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const entered = Promise.withResolvers<void>();
        const computation = Promise.withResolvers<void>();
        const releasing = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        onTestFinished(() => computation.resolve());
        onTestFinished(() => release.resolve());
        let available = true;
        let stopped = false;
        engine.includeTask('owned', {
            name: 'owned',
            maxConcurrency: () => 1,
            isWork: () => available,
            runnable: async () => {
                available = false;
                entered.resolve();
                try {
                    await computation.promise;
                    throw failure;
                }
                finally {
                    releasing.resolve();
                    await release.promise;
                }
            },
            ongoingTasks: []
        });
        await engine.executeOnce();
        await entered.promise;
        const stopping = engine.stop().then(
            () => ({ status: 'fulfilled' as const }),
            (error: unknown) => ({ status: 'rejected' as const, error: toError(error) })
        ).then((outcome) => {
            stopped = true;
            return outcome;
        });
        computation.resolve();
        await releasing.promise;
        expect(stopped, 'stop completed before runnable-owned release').toBe(false);
        expect(consoleError.mock.calls).toEqual([]);

        release.resolve();
        const outcome = await stopping;
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(outcome.status).toBe('rejected');
        if (outcome.status === 'rejected') {
            if (!(outcome.error instanceof AggregateError)) {
                throw outcome.error;
            }
            expect(outcome.error.errors).toEqual([failure]);
        }
        expect(unhandled).toEqual([]);
        expect(consoleError.mock.calls).toEqual([['Queue engine owned task failed', 'owned', failure]]);
    });

    it('schedules registered readiness using its supplied clock', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        let nowEpochMs = 10_000;
        const engine = new InboxOutboxEngine({
            nowEpochMs: () => nowEpochMs,
            random: () => 0.5,
            reportTaskFailure: (taskId, error) => {
                throw new AggregateError([error], `Unexpected failure in ${taskId}`);
            }
        });
        onTestFinished(() => engine.stop());
        const ranAt: number[] = [];
        engine.includeTask('receipt', {
            name: 'receipt',
            maxConcurrency: () => 1,
            isWork: () => ranAt.length === 0 && nowEpochMs >= 10_020,
            runnable: () => {
                ranAt.push(nowEpochMs);
            },
            ongoingTasks: []
        });
        engine.start();
        await vi.advanceTimersByTimeAsync(0);
        engine.wakeAt('receipt', 10_020);
        nowEpochMs = 10_020;
        await vi.advanceTimersByTimeAsync(20);

        expect(ranAt).toEqual([10_020]);
    });

    it('applies the existing idle jitter through its supplied random source', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const engine = new InboxOutboxEngine({
            nowEpochMs: () => Date.now(),
            random: () => 1,
            reportTaskFailure: (taskId, error) => {
                throw new AggregateError([error], `Unexpected failure in ${taskId}`);
            }
        });
        onTestFinished(() => engine.stop());
        const checkedAt: number[] = [];
        const startedAt = Date.now();
        engine.includeTask('idle', {
            name: 'idle',
            maxConcurrency: () => 1,
            isWork: () => {
                checkedAt.push(Date.now() - startedAt);
                return false;
            },
            runnable: () => {},
            ongoingTasks: []
        });
        engine.start();
        await vi.advanceTimersByTimeAsync(119);
        expect(checkedAt).toEqual([0]);
        await vi.advanceTimersByTimeAsync(1);
        expect(checkedAt).toEqual([0, 120]);
    });

    it('joins an excluded runnable through computation and resource release when stopped', async () => {
        const engine = new InboxOutboxEngine();
        onTestFinished(() => engine.stop());
        const entered = Promise.withResolvers<void>();
        const computation = Promise.withResolvers<void>();
        onTestFinished(() => computation.resolve());
        const releasing = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        onTestFinished(() => release.resolve());
        let available = true;
        let stopped = false;
        engine.includeTask('owned', {
            name: 'owned',
            maxConcurrency: () => 1,
            isWork: () => available,
            runnable: async () => {
                available = false;
                entered.resolve();
                try {
                    await computation.promise;
                }
                finally {
                    releasing.resolve();
                    await release.promise;
                }
            },
            ongoingTasks: []
        });
        await engine.executeOnce();
        await entered.promise;
        engine.excludeTask('owned');
        const stopping = Promise.resolve(engine.stop()).then(() => {
            stopped = true;
        });
        try {
            await Promise.resolve();
            expect(stopped, 'stop completed before owned computation').toBe(false);
            computation.resolve();
            await releasing.promise;
            expect(stopped, 'stop completed before resource release').toBe(false);
            release.resolve();
            await stopping;
            expect(stopped).toBe(true);
        }
        finally {
            computation.resolve();
            release.resolve();
            await stopping;
        }
    });

    it('tells every wake listener that an external writer announced work, until it is excluded', async () => {
        const engine = new InboxOutboxEngine();
        onTestFinished(() => engine.stop());
        const announced: string[] = [];
        engine.includeWakeListener('owner', () => announced.push('owner'));

        // A stopped engine schedules nothing, but the announcement is still true.
        engine.wakeAfterExternalWrite();
        // An owner waking for its own progress reschedules and announces nothing, and so does start().
        engine.wake();
        engine.start();
        expect(announced).toEqual(['owner']);

        engine.excludeWakeListener('owner');
        engine.wakeAfterExternalWrite();

        expect(announced).toEqual(['owner']);
        await engine.stop();
    });

    it('keeps one throwing wake listener from stealing the wake from the others', () => {
        const engine = new InboxOutboxEngine();
        onTestFinished(() => engine.stop());
        const announced: string[] = [];
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        engine.includeWakeListener('first', () => announced.push('first'));
        engine.includeWakeListener('throws', () => {
            throw new Error('listener refused the wake');
        });
        engine.includeWakeListener('last', () => announced.push('last'));

        engine.wakeAfterExternalWrite();

        // Every owner's remembered readiness is dropped, not just the ones ahead of the failure.
        expect(announced).toEqual(['first', 'last']);
        expect(consoleError).toHaveBeenCalledWith(
            'TaskEngine wake listener error',
            'throws',
            expect.objectContaining({ message: 'listener refused the wake' })
        );
    });

    it('wakes for a registered task deadline before idle backoff elapses', async () => {
        vi.useFakeTimers();
        const engine = new InboxOutboxEngine();
        onTestFinished(() => engine.stop());
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
        await engine.stop();
    });

    it('shares an active pass between scheduled and manual execution without duplicating work', async () => {
        vi.useFakeTimers();
        const engine = new InboxOutboxEngine();
        onTestFinished(() => engine.stop());
        const observed = Promise.withResolvers<void>();
        const available = Promise.withResolvers<boolean>();
        onTestFinished(() => available.resolve(false));
        const submitted = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        onTestFinished(() => release.resolve());
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
        const stopping = engine.stop();
        release.resolve();
        await vi.runAllTimersAsync();
        await stopping;
        expect(checks).toBe(1);
        expect(runs).toBe(1);
    });

    it.each(['remove', 'replace', 'stop'] as const)('does not submit an old task after %s while readiness is pending', async (change) => {
        vi.useFakeTimers();
        const engine = new InboxOutboxEngine();
        onTestFinished(() => engine.stop());
        const observed = Promise.withResolvers<void>();
        const available = Promise.withResolvers<boolean>();
        onTestFinished(() => available.resolve(false));
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
        let stopping: Promise<void> | undefined;
        const pending = engine.executeOnce();
        await observed.promise;
        if (change === 'remove') {
            engine.excludeTask('send');
        }
        else if (change === 'stop') {
            stopping = engine.stop();
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
        await stopping;
        if (change !== 'stop') {
            await engine.executeOnce();
        }
        expect(oldRuns).toBe(0);
        expect(newRuns).toBe(change === 'replace' ? 1 : 0);
    });

    it('fences a removed task whose executor has not invoked its runnable yet', async () => {
        const engine = new InboxOutboxEngine();
        onTestFinished(() => engine.stop());
        const scheduled = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        onTestFinished(() => release.resolve());
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
        onTestFinished(() => engine.stop());
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
        const engine = new InboxOutboxEngine();
        onTestFinished(() => engine.stop());
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
    });

    it('does not treat idle executions as circuit breaker failures', async () => {
        vi.useFakeTimers();
        const engine = new InboxOutboxEngine();
        onTestFinished(() => engine.stop());
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
    });

    it('preserves in-flight task state between executions', async () => {
        vi.useFakeTimers();
        const engine = new InboxOutboxEngine();
        onTestFinished(() => engine.stop());
        const taskGate = Promise.withResolvers<void>();
        onTestFinished(() => taskGate.resolve());
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
    });

    it('does not reschedule after stop during an active execution', async () => {
        vi.useFakeTimers();
        const engine = new InboxOutboxEngine();
        onTestFinished(() => engine.stop());
        const isWorkGate = Promise.withResolvers<boolean>();
        onTestFinished(() => isWorkGate.resolve(false));
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

        const stopping = engine.stop();
        isWorkGate.resolve(false);
        await vi.runAllTimersAsync();
        await stopping;

        const callsAfterStoppedRun = isWorkCalls;
        await vi.advanceTimersByTimeAsync(60_000);

        expect(isWorkCalls).toBe(callsAfterStoppedRun);
    });

    it('wakes an idle scheduled engine when work is enqueued', async () => {
        vi.useFakeTimers();
        const engine = new InboxOutboxEngine();
        onTestFinished(() => engine.stop());
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

        await engine.stop();
    });
});

async function executeOnceWithTimers(
    engine: InboxOutboxEngine
): Promise<boolean> {
    const runPromise = engine.executeOnce();
    await vi.runAllTimersAsync();

    return await runPromise;
}
