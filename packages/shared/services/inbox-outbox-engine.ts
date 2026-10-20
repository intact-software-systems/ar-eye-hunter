import { Temporal } from '@js-temporal/polyfill';

import { CircuitBreaker, CircuitBreakerPolicy } from '../resilience/circuit-breaker.ts';
import * as ComputeAsyncTask from '../resilience/ComputeAsyncTask.ts';
import { toError } from '../resilience/to-error.ts';

const NOT_SET = -1;

/**
 * The longest the engine waits between passes once nothing creates work: its idle ceiling, and the
 * horizon within which anything it did not itself schedule is discovered.
 */
export const INBOX_OUTBOX_ENGINE_MAX_IDLE_MS = 3_000;

/** The share by which the engine stretches or shortens each scheduled pass, so owners sharing a clock drift apart. */
export const INBOX_OUTBOX_ENGINE_SCHEDULE_JITTER_RATIO = 0.2;

interface InboxOutboxEngineWakeListener {
    readonly typeIds: ReadonlySet<string>;
    readonly listener: () => void;
}

const defaultInboxOutboxEngineDependencies: InboxOutboxEngine.Dependencies = {
    nowEpochMs: () => Date.now(),
    random: () => Math.random(),
    reportTaskFailure: reportInboxOutboxTaskFailure
};

export namespace InboxOutboxEngine {
    export interface Dependencies {
        readonly nowEpochMs: () => number;
        readonly random: () => number;
        /**
         * Receives each settled runnable failure synchronously once, after runnable-owned cleanup finishes, and a
         * task's readiness failure once per pass, which leaves only that task without work for the pass.
         */
        readonly reportTaskFailure: (taskId: string, error: Error) => undefined;
    }
}

export class InboxOutboxEngine {
    private static readonly MAX_BACKOFF: Temporal.Duration = Temporal.Duration.from({ milliseconds: 100 });
    private static readonly MAX_IS_WORK_CHECKS: number = 1_000;
    // The outer scheduler owns idle backoff; keep each engine pass responsive.
    private static readonly MAX_SUCCESSIVE_NO_TASKS_CREATED: number = 0;
    private static readonly FIXED_DELAY_SCHEDULED_ENGINE: Temporal.Duration = Temporal.Duration.from({
        milliseconds: 100
    });
    private static readonly MAX_IDLE_SCHEDULED_ENGINE: Temporal.Duration = Temporal.Duration.from({
        milliseconds: INBOX_OUTBOX_ENGINE_MAX_IDLE_MS
    });

    private static readonly defaultDuration: Temporal.Duration = Temporal.Duration.from({ seconds: 10 });
    private static readonly defaultSlidingWindowDuration: Temporal.Duration = Temporal.Duration.from({ minutes: 1 });
    private static readonly circuitBreakerPolicy: CircuitBreakerPolicy = new CircuitBreakerPolicy(
        10,
        InboxOutboxEngine.defaultDuration,
        InboxOutboxEngine.defaultDuration,
        InboxOutboxEngine.defaultSlidingWindowDuration
    );

    private readonly circuitBreaker: CircuitBreaker;

    private running = false;
    private timer: ReturnType<typeof setTimeout> | typeof NOT_SET = NOT_SET;
    private execution: Promise<boolean> | undefined;
    private generation = 0;
    private wakeAfterExecution = false;
    private successiveIdleExecutions = 0;
    private scheduledAtMs: number | undefined;
    /**
     * The wakes requested so far. A wake's pass skips a task whose slot a runnable still holds, so a
     * runnable that ends after a wake it predates brings the next pass forward in that wake's place.
     */
    private wakeCount = 0;

    private readonly tasksInFlight = new Map<Promise<void>, Promise<void>>();

    private readonly tasks = new Map<string, ComputeAsyncTask.LoopsTaskDto>();
    private readonly readyAtByTask = new Map<string, number>();
    private readonly wakeListeners = new Map<string, InboxOutboxEngineWakeListener>();

    private readonly dependencies: InboxOutboxEngine.Dependencies;

    constructor(dependencies: InboxOutboxEngine.Dependencies = defaultInboxOutboxEngineDependencies) {
        this.dependencies = dependencies;
        this.circuitBreaker = CircuitBreaker.createWithTs(
            InboxOutboxEngine.circuitBreakerPolicy,
            dependencies.nowEpochMs()
        );
    }

    includeTask(id: string, task: ComputeAsyncTask.LoopsTaskDto): InboxOutboxEngine {
        this.readyAtByTask.delete(id);
        for (const ongoing of task.ongoingTasks) {
            if (!ongoing.done) {
                this.retainTaskCompletion(id, ongoing.promise);
            }
        }
        this.tasks.set(id, { ...task, name: id, ongoingTasks: [...task.ongoingTasks] });
        return this;
    }

    excludeTask(id: string): boolean {
        this.readyAtByTask.delete(id);
        return this.tasks.delete(id);
    }

    /**
     * Registers a listener for the external-write wakes of its queue types. Such a wake is the
     * announcement that a writer this engine does not own may have written rows of those types, so a
     * task that answers readiness from memory drops that memory here instead of waiting out the idle
     * ceiling. The owners' own progress reaches `wake` instead and notifies nobody. A listener runs
     * synchronously during the wake and must not wake the engine. One that throws is reported and
     * skipped: the announcement is one every other owner of those types still needs.
     */
    includeWakeListener(id: string, typeIds: ReadonlySet<string>, listener: () => void): InboxOutboxEngine {
        this.wakeListeners.set(id, { typeIds, listener });
        return this;
    }

    excludeWakeListener(id: string): boolean {
        return this.wakeListeners.delete(id);
    }

    wakeAt(taskId: string, readyAtMs: number | undefined): void {
        if (!this.tasks.has(taskId)) {
            return;
        }
        if (readyAtMs === undefined) {
            this.readyAtByTask.delete(taskId);
            return;
        }
        if (!Number.isSafeInteger(readyAtMs) || readyAtMs < 0) {
            throw new RangeError('Queue task readiness must be a non-negative safe timestamp');
        }
        this.readyAtByTask.set(taskId, readyAtMs);
        if (this.running && this.execution === undefined) {
            const earliest = Math.min(this.scheduledAtMs ?? readyAtMs, readyAtMs);
            this.scheduleEngine(Math.max(0, earliest - this.dependencies.nowEpochMs()));
        }
    }

    /**
     * Keeps work a task's runnable started and returned without awaiting, such as the rows a queue reader holds in
     * flight across passes: `stop` waits for it, a rejection is reported once like a failed runnable's, and its
     * settlement wakes the engine, since it frees capacity the task's next pass can use.
     */
    retainSettlingWork(taskId: string, completion: Promise<void>): void {
        void this.retainTaskCompletion(taskId, completion).then(() => this.wake());
    }

    start(): void {
        if (this.running) {
            return;
        }

        this.running = true;
        this.wake();
    }

    async stop(): Promise<void> {
        this.generation += 1;
        this.running = false;
        this.wakeAfterExecution = false;
        if (this.timer !== NOT_SET) {
            clearTimeout(this.timer);
        }
        this.timer = NOT_SET;
        this.scheduledAtMs = undefined;

        const failures = await this.joinTasksInFlight();
        if (failures.length > 0) {
            throw new AggregateError(failures, 'Queue engine owned work failed during shutdown');
        }
    }

    /** Settling work may retain more while it is joined, such as a runnable that claims rows, so the join repeats. */
    private async joinTasksInFlight(): Promise<Error[]> {
        const started = [...this.tasksInFlight.keys()];
        await this.execution;
        const joined = new Set<Promise<void>>();
        const failures: Error[] = [];
        let pending = [...new Set([...started, ...this.tasksInFlight.keys()])];
        while (pending.length > 0) {
            pending.forEach((completion) => joined.add(completion));
            const outcomes = await Promise.allSettled(pending);
            failures.push(
                ...outcomes.flatMap((outcome) => outcome.status === 'rejected' ? [toError(outcome.reason)] : [])
            );
            pending = [...this.tasksInFlight.keys()].filter((completion) => !joined.has(completion));
        }
        return failures;
    }

    /**
     * Brings the next pass forward and tells no one. This is the owners' own progress -- a batch that
     * ended, a commit an owner made itself, a retained claim settling, the first start -- and every
     * such path already invalidated the memory its own write staled. Announcing it here would instead
     * make each owner drop the answers of every other owner sharing the engine.
     */
    wake(): void {
        this.wakeCount += 1;
        this.rescheduleNow();
    }

    /**
     * The announcement that a writer this engine does not own put rows of `typeIds` in a queue: a server
     * AppInbox transaction or a pub/sub requeue; no browser code makes it. Such a writer cannot say
     * which owner a row belongs to, so every owner of those types drops its remembered readiness and
     * re-reads storage once; an owner of other types keeps its answer.
     */
    wakeAfterExternalWrite(typeIds: ReadonlySet<string>): void {
        this.notifyWake(typeIds);
        this.wakeCount += 1;
        this.rescheduleNow();
    }

    private rescheduleNow(): void {
        if (!this.running) {
            return;
        }

        this.successiveIdleExecutions = 0;

        if (this.timer !== NOT_SET) {
            clearTimeout(this.timer);
            this.timer = NOT_SET;
        }

        if (this.execution) {
            this.wakeAfterExecution = true;
            return;
        }

        this.scheduleEngine(0);
    }

    executeOnce(): Promise<boolean> {
        if (this.execution) {
            return this.execution;
        }
        if (this.timer !== NOT_SET) {
            clearTimeout(this.timer);
            this.timer = NOT_SET;
        }
        this.scheduledAtMs = undefined;
        const nowMs = this.dependencies.nowEpochMs();
        for (const [taskId, readyAtMs] of this.readyAtByTask) {
            if (readyAtMs <= nowMs) {
                this.readyAtByTask.delete(taskId);
            }
        }
        let taskCreated = false;
        this.execution = this.executeTaskEngine()
            .then((result) => {
                taskCreated = result;
                return result;
            })
            .finally(() => {
                this.execution = undefined;
                if (this.running) {
                    const delayMs = this.wakeAfterExecution ? 0 : this.nextScheduleDelayMs(taskCreated);
                    this.wakeAfterExecution = false;
                    this.scheduleEngine(delayMs);
                }
            });
        return this.execution;
    }

    private notifyWake(typeIds: ReadonlySet<string>): void {
        for (const [id, { typeIds: listenedTypeIds, listener }] of this.wakeListeners) {
            if (![...listenedTypeIds].some((typeId) => typeIds.has(typeId))) {
                continue;
            }
            try {
                listener();
            }
            catch (error) {
                console.error('TaskEngine wake listener error', id, toError(error));
            }
        }
    }

    private scheduleEngine(delayMs: number): void {
        if (!this.running) {
            return;
        }
        if (this.timer !== NOT_SET) {
            clearTimeout(this.timer);
        }
        const nowMs = this.dependencies.nowEpochMs();
        let scheduledAtMs = nowMs + delayMs;
        for (const readyAtMs of this.readyAtByTask.values()) {
            scheduledAtMs = Math.min(scheduledAtMs, readyAtMs);
        }
        this.scheduledAtMs = Math.max(nowMs, scheduledAtMs);
        this.timer = setTimeout(() => {
            this.timer = NOT_SET;
            this.scheduledAtMs = undefined;
            void this.executeOnce();
        }, this.scheduledAtMs - nowMs);
    }

    private async executeTaskEngine(): Promise<boolean> {
        try {
            if (!this.circuitBreaker.allowAt(this.dependencies.nowEpochMs())) {
                return false;
            }
            const registrations = new Map(this.tasks);
            const generation = this.generation;
            const computedDto = await ComputeAsyncTask.runLoopsWhileWork(
                InboxOutboxEngine.toAsyncTaskInput(
                    [...registrations.values()].map((task) => this.toTaskPass(task, generation))
                )
            );

            for (const task of computedDto.tasks) {
                const registration = registrations.get(task.inputTask.name);
                if (registration && this.tasks.get(task.inputTask.name) === registration) {
                    registration.ongoingTasks = task.tasksInFlight;
                }
            }
            this.circuitBreaker.successAt(this.dependencies.nowEpochMs());
            return computedDto.totalNumTasksCreated > 0;
        }
        catch (error) {
            this.circuitBreaker.failureAt(this.dependencies.nowEpochMs());
            console.error('TaskEngine error', toError(error));
            return false;
        }
    }

    private toTaskPass(task: ComputeAsyncTask.LoopsTaskDto, generation: number): ComputeAsyncTask.LoopsTaskDto {
        let readinessFailed = false;
        return {
            ...task,
            executor: (runnable) =>
                this.retainTaskCompletion(
                    task.name,
                    task.executor === undefined ? Promise.resolve().then(runnable) : task.executor(runnable)
                ),
            maxConcurrency: async () => this.isCurrentTask(task, generation) ? await task.maxConcurrency() : 0,
            isWork: async () => {
                if (readinessFailed || !this.isCurrentTask(task, generation)) {
                    return false;
                }
                try {
                    const isWork = await task.isWork();
                    return isWork && this.isCurrentTask(task, generation);
                }
                catch (error) {
                    readinessFailed = true;
                    this.reportTaskFailure(task.name, toError(error));
                    return false;
                }
            },
            runnable: async () => {
                if (this.isCurrentTask(task, generation)) {
                    await task.runnable();
                }
            }
        };
    }

    private retainTaskCompletion(taskId: string, completion: Promise<void>): Promise<void> {
        const retained = this.tasksInFlight.get(completion);
        if (retained !== undefined) {
            return retained;
        }
        const wakeCountAtSubmit = this.wakeCount;
        const observation = completion.then(
            () => {
                this.tasksInFlight.delete(completion);
                this.rescheduleAfterMissedWake(wakeCountAtSubmit);
            },
            (error: unknown) => {
                this.tasksInFlight.delete(completion);
                this.reportTaskFailure(taskId, toError(error));
                this.rescheduleAfterMissedWake(wakeCountAtSubmit);
            }
        );
        this.tasksInFlight.set(completion, observation);
        return observation;
    }

    private rescheduleAfterMissedWake(wakeCountAtSubmit: number): void {
        if (this.wakeCount !== wakeCountAtSubmit) {
            this.rescheduleNow();
        }
    }

    private reportTaskFailure(taskId: string, error: Error): void {
        try {
            this.dependencies.reportTaskFailure(taskId, error);
        }
        catch (reporterError) {
            reportInboxOutboxTaskFailure(
                taskId,
                new AggregateError([error, toError(reporterError)], 'Queue task failure reporter failed')
            );
        }
    }

    private isCurrentTask(task: ComputeAsyncTask.LoopsTaskDto, generation: number): boolean {
        return generation === this.generation && this.tasks.get(task.name) === task;
    }

    private nextScheduleDelayMs(taskCreated: boolean): number {
        if (taskCreated) {
            this.successiveIdleExecutions = 0;
            return InboxOutboxEngine.FIXED_DELAY_SCHEDULED_ENGINE.total({ unit: 'milliseconds' });
        }

        this.successiveIdleExecutions += 1;
        const baseDelayMs = InboxOutboxEngine.FIXED_DELAY_SCHEDULED_ENGINE.total({ unit: 'milliseconds' });
        const maxDelayMs = InboxOutboxEngine.MAX_IDLE_SCHEDULED_ENGINE.total({ unit: 'milliseconds' });
        const delayMs = ComputeAsyncTask.toExponentialBackoffMs(this.successiveIdleExecutions, maxDelayMs, baseDelayMs);

        return this.withJitter(delayMs);
    }

    private withJitter(delayMs: number): number {
        const jitterRangeMs = delayMs * INBOX_OUTBOX_ENGINE_SCHEDULE_JITTER_RATIO;
        const jitterMs = Math.round((this.dependencies.random() * 2 - 1) * jitterRangeMs);

        return Math.max(0, delayMs + jitterMs);
    }

    private static toAsyncTaskInput(
        tasks: readonly ComputeAsyncTask.LoopsTaskDto[]
    ) {
        return {
            tasks: tasks,
            maxBackoffMs: InboxOutboxEngine.MAX_BACKOFF.total({ unit: 'milliseconds' }),
            maxIsWorkIterations: InboxOutboxEngine.MAX_IS_WORK_CHECKS,
            maxSuccessiveNoTasksCreated: InboxOutboxEngine.MAX_SUCCESSIVE_NO_TASKS_CREATED
        };
    }
}

function reportInboxOutboxTaskFailure(taskId: string, error: Error): undefined {
    console.error('Queue engine owned task failed', taskId, error);
}
