// ComputeAsyncTask.ts
// A concurrency-limited async task pump with exponential backoff.
// Designed for I/O promise-based tasks (fetch, ws/webrtc sends, db calls, etc.)
// deno-lint-ignore-file

export type SleepFn = (ms: number) => Promise<void>;
export type NowMsFn = () => number;

export type AsyncRunnable = () => void | Promise<void>;
export type AsyncSupplier<T> = () => T | Promise<T>;

// TODO: Can decorate with timers, etc and engine can have a timeout policy to interrupt tasks that take too long
export class TrackedTask {
    public done = false;
    public readonly promise: Promise<void>;

    constructor(promise: Promise<void>) {
        // ensure we flip done regardless of success/failure
        this.promise = promise.finally(() => {
            this.done = true;
        });
    }
}

export function track(p: Promise<void>): TrackedTask {
    return new TrackedTask(p);
}

export function filterOutFinishedTasks(tasks: readonly TrackedTask[]): TrackedTask[] {
    return tasks.filter((t) => !t.done);
}

export function isAllowedToAddTask(tasksInFlight: readonly TrackedTask[], maxConcurrency: number): boolean {
    return tasksInFlight.length < maxConcurrency;
}

export async function waitForAll(
    tasks: readonly TrackedTask[],
    maxWaitMs: number,
    opts: { sleep?: SleepFn; nowMs?: NowMsFn; pollIntervalMs?: number } = {},
): Promise<TrackedTask[]> {
    const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    const nowMs = opts.nowMs ?? (() => Date.now());
    const poll = opts.pollIntervalMs ?? 10;

    const deadline = nowMs() + maxWaitMs;

    // quick exit
    if (tasks.every((t) => t.done)) return [];

    while (nowMs() < deadline) {
        const remaining = tasks.filter((t) => !t.done);
        if (remaining.length === 0) return [];
        await sleep(poll);
    }

    // Not completed within deadline:
    return tasks.filter((t) => !t.done);
}

export function toExponentialBackoffMs(
    attempt: number,
    maxBackoffMs: number,
    baseMs = 10,
): number {
    // base * 2^(attempt-1), capped
    const raw = baseMs * Math.pow(2, Math.max(0, attempt - 1));
    return Math.min(maxBackoffMs, Math.round(raw));
}

// ------------------------------------------------------------
// Submit: compute number of tasks to create and start them
// ------------------------------------------------------------

export namespace Submit {
    export type Executor = (runnable: AsyncRunnable) => Promise<void>;

    export interface InputDto {
        runnable: AsyncRunnable;
        ongoingTasks: readonly TrackedTask[];
        maxConcurrency: number;
        executor?: Executor;
    }

    export interface ComputedDto {
        tasksInFlight: TrackedTask[];
        tasksCreated: number;
    }

    const defaultExecutor: Executor = async (r) => {
        // Ensure async scheduling, but do not block.
        await Promise.resolve().then(r);
    };

    export function submitAsyncTasks(input: InputDto): ComputedDto {
        const active = filterOutFinishedTasks(input.ongoingTasks);
        const toCreate = input.maxConcurrency - active.length;

        if (toCreate <= 0) {
            return { tasksInFlight: active, tasksCreated: 0 };
        }

        const exec = input.executor ?? defaultExecutor;

        const created: TrackedTask[] = [];
        for (let i = 0; i < toCreate; i++) {
            const p = exec(input.runnable);
            created.push(track(p));
        }

        return {
            tasksInFlight: active.concat(created),
            tasksCreated: toCreate,
        };
    }
}

// ------------------------------------------------------------
// Loop: single task pump
// ------------------------------------------------------------

export namespace Loop {
    export interface InputDto {
        maxConcurrency: AsyncSupplier<number>;
        isWork: AsyncSupplier<boolean>;
        runnable: AsyncRunnable;
        ongoingTasks: readonly TrackedTask[];
        maxBackoffMs: number;
        maxIsWorkIterations: number;
        sleep?: SleepFn;
        executor?: Submit.Executor;
    }

    export interface ComputedDto {
        tasksInFlight: TrackedTask[];
        tasksCreatedTotal: number;
        numIsWorkIterations: number;
        numNoTasksCreatedIterations: number;
    }

    export async function runWhileWork(input: InputDto): Promise<ComputedDto> {
        const sleep = input.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

        let numIsWorkIterations = 0;
        let numSuccessiveNoTasksCreated = 0;
        let tasksCreatedTotal = 0;

        let tasksInFlight = filterOutFinishedTasks(input.ongoingTasks);

        while (numIsWorkIterations++ < input.maxIsWorkIterations) {
            const maxConc = await input.maxConcurrency();

            const allowed = isAllowedToAddTask(tasksInFlight, maxConc);

            // Preserve Java logic: if allowed && isWork is false -> break, else continue
            let isWork = true;
            if (allowed) {
                isWork = await input.isWork();
                if (!isWork) break;
            }

            if (allowed) {
                const computed = Submit.submitAsyncTasks({
                    runnable: input.runnable,
                    ongoingTasks: tasksInFlight,
                    maxConcurrency: maxConc,
                    executor: input.executor,
                });

                tasksInFlight = computed.tasksInFlight;
                tasksCreatedTotal += computed.tasksCreated;

                if (computed.tasksCreated > 0) {
                    numSuccessiveNoTasksCreated = 0;
                } else {
                    numSuccessiveNoTasksCreated++;
                    const backoff = toExponentialBackoffMs(numSuccessiveNoTasksCreated, input.maxBackoffMs);
                    await sleep(backoff);
                }
            } else {
                tasksInFlight = filterOutFinishedTasks(tasksInFlight);
                numSuccessiveNoTasksCreated++;
                const backoff = toExponentialBackoffMs(numSuccessiveNoTasksCreated, input.maxBackoffMs);
                await sleep(backoff);
            }
        }

        return {
            tasksInFlight,
            tasksCreatedTotal,
            numIsWorkIterations: numIsWorkIterations - 1,
            numNoTasksCreatedIterations: numSuccessiveNoTasksCreated,
        };
    }
}

// ------------------------------------------------------------
// Loops: multiple task pumps in one outer loop
// ------------------------------------------------------------

export namespace Loops {
    export interface TaskDto {
        name: string;
        maxConcurrency: AsyncSupplier<number>;
        isWork: AsyncSupplier<boolean>;
        runnable: AsyncRunnable;
        ongoingTasks: readonly TrackedTask[];
        executor?: Submit.Executor;
    }

    export interface InputDto {
        tasks: readonly TaskDto[];
        maxBackoffMs: number;
        maxIsWorkIterations: number;
        maxSuccessiveNoTasksCreated: number;
        sleep?: SleepFn;
    }

    export interface ComputedTaskDto {
        inputTask: TaskDto;
        tasksInFlight: TrackedTask[];
        tasksCreated: number;
    }

    export interface ComputedDto {
        tasks: ComputedTaskDto[];
        totalNumTasksCreated: number;
        numIsWorkIterations: number;
        numSuccessiveNoTasksCreated: number;
    }

    export async function runWhileWork(input: InputDto): Promise<ComputedDto> {
        const sleep = input.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

        // initialize computed task state
        const tasks: ComputedTaskDto[] = input.tasks.map((t) => ({
            inputTask: t,
            tasksInFlight: filterOutFinishedTasks(t.ongoingTasks),
            tasksCreated: 0,
        }));

        let numIsWorkIterations = 0;
        let numSuccessiveNoTasksCreated = 0;
        let totalNumTasksCreated = 0;

        while (
            numIsWorkIterations++ <= input.maxIsWorkIterations &&
            numSuccessiveNoTasksCreated <= input.maxSuccessiveNoTasksCreated
            ) {
            // one "round" across all tasks
            let createdThisRound = 0;

            for (const ct of tasks) {
                const maxConc = await ct.inputTask.maxConcurrency();
                const allowed = isAllowedToAddTask(ct.tasksInFlight, maxConc);

                if (allowed && (await ct.inputTask.isWork())) {
                    const computed = Submit.submitAsyncTasks({
                        runnable: ct.inputTask.runnable,
                        ongoingTasks: ct.tasksInFlight,
                        maxConcurrency: maxConc,
                        executor: ct.inputTask.executor,
                    });
                    ct.tasksInFlight = computed.tasksInFlight;
                    ct.tasksCreated = computed.tasksCreated;
                    createdThisRound += computed.tasksCreated;
                } else {
                    ct.tasksInFlight = filterOutFinishedTasks(ct.tasksInFlight);
                    ct.tasksCreated = 0;
                }
            }

            totalNumTasksCreated += createdThisRound;

            if (createdThisRound > 0) {
                numSuccessiveNoTasksCreated = 0;
            } else {
                numSuccessiveNoTasksCreated++;
                const backoff = toExponentialBackoffMs(numSuccessiveNoTasksCreated, input.maxBackoffMs);
                await sleep(backoff);
            }
        }

        return {
            tasks,
            totalNumTasksCreated,
            numIsWorkIterations: numIsWorkIterations - 1,
            numSuccessiveNoTasksCreated
        };
    }
}