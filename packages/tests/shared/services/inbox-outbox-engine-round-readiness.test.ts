import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

/** A durable lane's readiness probe reads IndexedDB; on a loaded runner one read took this long. */
const DURABLE_PROBE_MS = 900;

beforeEach(() =>
    onTestFinished(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    })
);

describe('InboxOutboxEngine round readiness', () => {
    it('starts a task that answers ready without waiting for a sibling whose readiness probe is slow', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const engine = createEngine();
        const durableProbes = includeSlowProbeTask(engine);
        const stage = includeStageTask(engine);
        engine.start();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(durableProbes.length).toBeGreaterThan(0);

        const stagedAtMs = Date.now();
        stage.staged = true;
        engine.wake();
        await vi.advanceTimersByTimeAsync(DURABLE_PROBE_MS + 10);

        expect(stage.ranAtMs).toEqual([stagedAtMs]);
    });

    it('still submits the ready tasks of a round in which another task fails its readiness', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const failures: string[] = [];
        const engine = createEngine((taskId, error) => {
            failures.push(`${taskId}: ${error.message}`);
            return undefined;
        });
        engine.includeTask('failing', {
            name: 'failing',
            maxConcurrency: () => 1,
            isWork: () => Promise.reject(new Error('readiness storage unavailable')),
            runnable: () => Promise.resolve(),
            ongoingTasks: []
        });
        const stage = includeStageTask(engine);
        stage.staged = true;
        engine.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(stage.ranAtMs).toEqual([10_000]);
        expect(failures).toEqual(['failing: readiness storage unavailable']);
    });
});

interface StageTask {
    staged: boolean;
    readonly ranAtMs: number[];
}

function createEngine(
    reportTaskFailure: InboxOutboxEngine.Dependencies['reportTaskFailure'] = (taskId, error) => {
        throw new AggregateError([error], `Unexpected failure in ${taskId}`);
    }
): InboxOutboxEngine {
    const engine = new InboxOutboxEngine({ nowEpochMs: () => Date.now(), random: () => 0.5, reportTaskFailure });
    onTestFinished(async () => {
        const stopping = engine.stop();
        // The stop joins a probe still in flight, which only fake time can finish.
        await vi.advanceTimersByTimeAsync(DURABLE_PROBE_MS);
        await stopping;
    });
    return engine;
}

/** Like a durable ALM lane: its probe reads storage and, idle, answers no work. */
function includeSlowProbeTask(engine: InboxOutboxEngine): number[] {
    const probedAtMs: number[] = [];
    engine.includeTask('durable-lane', {
        name: 'durable-lane',
        maxConcurrency: () => 1,
        isWork: () => {
            probedAtMs.push(Date.now());
            return new Promise<boolean>((resolve) => setTimeout(() => resolve(false), DURABLE_PROBE_MS));
        },
        runnable: () => Promise.resolve(),
        ongoingTasks: []
    });
    return probedAtMs;
}

/** Like the publication stage: its readiness is an in-memory "a lane is due". */
function includeStageTask(engine: InboxOutboxEngine): StageTask {
    const stage: StageTask = { staged: false, ranAtMs: [] };
    engine.includeTask('publication-stage', {
        name: 'publication-stage',
        maxConcurrency: () => 1,
        isWork: () => stage.staged,
        runnable: () => {
            stage.staged = false;
            stage.ranAtMs.push(Date.now());
            return Promise.resolve();
        },
        ongoingTasks: []
    });
    return stage;
}
