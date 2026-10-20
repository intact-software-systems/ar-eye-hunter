import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

interface BusySlotTask {
    readonly probedAtMs: number[];
    readonly ranAtMs: number[];
    /** Rows a writer the runnable did not see has left behind. */
    waitingRows: number;
    /** Ends the runnable in flight, which claimed nothing and so wakes no one. */
    finishRunnable(): void;
    /** Fails the runnable in flight, which wakes no one either. */
    failRunnable(error: Error): void;
}

beforeEach(() =>
    onTestFinished(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    })
);

describe('InboxOutboxEngine wake while a task slot is busy', () => {
    it('runs the next pass as soon as a runnable that a wake found busy ends', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const engine = createEngine();
        const task = includeBusySlotTask(engine);
        task.waitingRows = 1;
        engine.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(task.ranAtMs).toEqual([10_000]);

        await vi.advanceTimersByTimeAsync(10);
        task.waitingRows = 1;
        engine.wakeAfterExternalWrite(new Set(['APP_INBOX']));
        await vi.advanceTimersByTimeAsync(10);
        task.finishRunnable();
        await vi.advanceTimersByTimeAsync(0);

        expect(task.probedAtMs).toEqual([10_000, 10_020]);
        expect(task.ranAtMs).toEqual([10_000, 10_020]);
        task.finishRunnable();
    });

    it('runs the next pass as soon as a failed runnable that a wake found busy is reported', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const failures: string[] = [];
        const engine = createEngine((taskId, error) => {
            failures.push(`${taskId}: ${error.message}`);
            return undefined;
        });
        const task = includeBusySlotTask(engine);
        task.waitingRows = 1;
        engine.start();
        await vi.advanceTimersByTimeAsync(10);
        task.waitingRows = 1;
        engine.wake();
        await vi.advanceTimersByTimeAsync(10);
        task.failRunnable(new Error('claim storage unavailable'));
        await vi.advanceTimersByTimeAsync(0);

        expect(failures).toEqual(['inbox: claim storage unavailable']);
        expect(task.ranAtMs).toEqual([10_000, 10_020]);
        task.finishRunnable();
    });

    it('keeps the scheduled delay when no wake arrived while the runnable was in flight', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const engine = createEngine();
        const task = includeBusySlotTask(engine);
        task.waitingRows = 1;
        engine.start();
        await vi.advanceTimersByTimeAsync(20);
        task.finishRunnable();
        await vi.advanceTimersByTimeAsync(79);

        expect(task.probedAtMs).toEqual([10_000]);
        await vi.advanceTimersByTimeAsync(1);
        expect(task.probedAtMs).toEqual([10_000, 10_100]);
    });
});

function createEngine(
    reportTaskFailure: InboxOutboxEngine.Dependencies['reportTaskFailure'] = (taskId, error) => {
        throw new AggregateError([error], `Unexpected failure in ${taskId}`);
    }
): InboxOutboxEngine {
    const engine = new InboxOutboxEngine({ nowEpochMs: () => Date.now(), random: () => 0.5, reportTaskFailure });
    onTestFinished(() => engine.stop());
    return engine;
}

function includeBusySlotTask(engine: InboxOutboxEngine): BusySlotTask {
    let settle: PromiseWithResolvers<void> | undefined;
    const task: BusySlotTask = {
        probedAtMs: [],
        ranAtMs: [],
        waitingRows: 0,
        finishRunnable: () => settle?.resolve(),
        failRunnable: (error) => settle?.reject(error)
    };
    engine.includeTask('inbox', {
        name: 'inbox',
        maxConcurrency: () => 1,
        isWork: () => {
            task.probedAtMs.push(Date.now());
            return task.waitingRows > 0;
        },
        runnable: async () => {
            task.ranAtMs.push(Date.now());
            task.waitingRows = 0;
            settle = Promise.withResolvers<void>();
            await settle.promise;
        },
        ongoingTasks: []
    });
    return task;
}
