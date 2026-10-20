import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

interface FlightTask {
    readonly ranAtMs: number[];
    /** Rows the next runnable claims into its flight; each claimed row stays in flight until the test settles it. */
    waitingRows: number;
    /** The flight rows claimed so far, in claim order. */
    readonly rows: PromiseWithResolvers<void>[];
}

beforeEach(() =>
    onTestFinished(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    })
);

describe('InboxOutboxEngine work a runnable leaves settling', () => {
    it('stops only once every row a returned runnable left settling has settled', async () => {
        vi.useFakeTimers({ now: 10_000 });
        const engine = createEngine();
        const task = includeFlightTask(engine);
        task.waitingRows = 2;
        engine.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(task.rows).toHaveLength(2);

        let stopped = false;
        const stopping = engine.stop().then(() => {
            stopped = true;
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(stopped).toBe(false);
        task.rows[0]!.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(stopped).toBe(false);
        task.rows[1]!.resolve();
        await stopping;

        expect(stopped).toBe(true);
    });

    it('also joins work a runnable retains while stop already waits for that runnable', async () => {
        const engine = createEngine();
        const runnableGate = Promise.withResolvers<void>();
        const lateRow = Promise.withResolvers<void>();
        let work = 1;
        let started = false;
        engine.includeTask('inbox', {
            name: 'inbox',
            maxConcurrency: () => 1,
            isWork: () => work-- > 0,
            runnable: async () => {
                started = true;
                await runnableGate.promise;
                engine.retainSettlingWork('inbox', lateRow.promise);
            },
            ongoingTasks: []
        });
        engine.start();
        await vi.waitFor(() => expect(started).toBe(true));

        let stopped = false;
        const stopping = engine.stop().then(() => {
            stopped = true;
        });
        runnableGate.resolve();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(stopped).toBe(false);
        lateRow.resolve();
        await stopping;

        expect(stopped).toBe(true);
    });

    it('reports a row that settles by rejecting once, and stop rejects with it when it settles during shutdown', async () => {
        vi.useFakeTimers({ now: 10_000 });
        const failures: string[] = [];
        const engine = createEngine((taskId, error) => {
            failures.push(`${taskId}: ${error.message}`);
            return undefined;
        });
        const task = includeFlightTask(engine);
        task.waitingRows = 1;
        engine.start();
        await vi.advanceTimersByTimeAsync(0);

        const stopping = engine.stop();
        task.rows[0]!.reject(new Error('release lost its reservation'));

        await expect(stopping).rejects.toThrow(AggregateError);
        expect(failures).toEqual(['inbox: release lost its reservation']);
    });

    it('wakes an engine that idles behind its backoff as soon as a row it left settling settles', async () => {
        vi.useFakeTimers({ now: 10_000 });
        const engine = createEngine();
        const task = includeFlightTask(engine);
        task.waitingRows = 1;
        engine.start();
        await vi.advanceTimersByTimeAsync(0);
        // Idle passes stretch the backoff toward its ceiling while the claimed row is in flight.
        await vi.advanceTimersByTimeAsync(5_000);
        const idleRuns = task.ranAtMs.length;

        task.waitingRows = 1;
        vi.setSystemTime(Date.now());
        const settledAtMs = Date.now();
        task.rows[0]!.resolve();
        await vi.advanceTimersByTimeAsync(0);

        expect(task.ranAtMs.length).toBe(idleRuns + 1);
        expect(task.ranAtMs.at(-1)).toBe(settledAtMs);
        task.rows[1]!.resolve();
        await engine.stop();
    });
});

function createEngine(
    reportTaskFailure: InboxOutboxEngine.Dependencies['reportTaskFailure'] = () => undefined
): InboxOutboxEngine {
    return new InboxOutboxEngine({ nowEpochMs: () => Date.now(), random: () => 0.5, reportTaskFailure });
}

/** A task whose runnable claims every waiting row into a flight it hands to the engine, and returns at once. */
function includeFlightTask(engine: InboxOutboxEngine): FlightTask {
    const task: FlightTask = { ranAtMs: [], waitingRows: 0, rows: [] };
    engine.includeTask('inbox', {
        name: 'inbox',
        maxConcurrency: () => 1,
        isWork: () => task.waitingRows > 0,
        runnable: async () => {
            task.ranAtMs.push(Date.now());
            for (; task.waitingRows > 0; task.waitingRows -= 1) {
                const row = Promise.withResolvers<void>();
                task.rows.push(row);
                engine.retainSettlingWork('inbox', row.promise);
            }
        },
        ongoingTasks: []
    });
    return task;
}
