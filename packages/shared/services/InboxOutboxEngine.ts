import { Temporal } from '@js-temporal/polyfill';
import { CircuitBreaker, CircuitBreakerPolicy } from '../resilience/circuit-breaker.ts';
import * as ComputeAsyncTask from '../resilience/ComputeAsyncTask.ts';

const NOT_SET = -1;

export class InboxOutboxEngine {
    private static readonly MAX_BACKOFF: Temporal.Duration = Temporal.Duration.from({ milliseconds: 100 });
    private static readonly MAX_IS_WORK_CHECKS: number = 1_000;
    // The outer scheduler owns idle backoff; keep each engine pass responsive.
    private static readonly MAX_SUCCESSIVE_NO_TASKS_CREATED: number = 0;
    private static readonly FIXED_DELAY_SCHEDULED_ENGINE: Temporal.Duration = Temporal.Duration.from({
        milliseconds: 100
    });
    private static readonly MAX_IDLE_SCHEDULED_ENGINE: Temporal.Duration = Temporal.Duration.from({ seconds: 3 });
    private static readonly SCHEDULE_JITTER_RATIO = 0.2;

    private static readonly defaultDuration: Temporal.Duration = Temporal.Duration.from({ seconds: 10 });
    private static readonly defaultSlidingWindowDuration: Temporal.Duration = Temporal.Duration.from({ minutes: 1 });
    private static readonly circuitBreakerPolicy: CircuitBreakerPolicy = new CircuitBreakerPolicy(
        10,
        InboxOutboxEngine.defaultDuration,
        InboxOutboxEngine.defaultDuration,
        InboxOutboxEngine.defaultSlidingWindowDuration
    );

    private readonly circuitBreaker: CircuitBreaker = CircuitBreaker.create(InboxOutboxEngine.circuitBreakerPolicy);

    private running = false;
    private timer: ReturnType<typeof setTimeout> | typeof NOT_SET = NOT_SET;
    private execution: Promise<boolean> | undefined;
    private generation = 0;
    private wakeAfterExecution = false;
    private successiveIdleExecutions = 0;
    private scheduledAtMs: number | undefined;

    private readonly tasks = new Map<string, ComputeAsyncTask.LoopsTaskDto>();
    private readonly readyAtByTask = new Map<string, number>();

    includeTask(id: string, task: ComputeAsyncTask.LoopsTaskDto): InboxOutboxEngine {
        this.readyAtByTask.delete(id);
        this.tasks.set(id, { ...task, name: id, ongoingTasks: [...task.ongoingTasks] });
        return this;
    }

    excludeTask(id: string): boolean {
        this.readyAtByTask.delete(id);
        return this.tasks.delete(id);
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
            this.scheduleEngine(Math.max(0, earliest - Date.now()));
        }
    }

    start(): void {
        if (this.running) {
            return;
        }

        this.running = true;
        this.wake();
    }

    stop(): void {
        this.generation += 1;
        this.running = false;
        this.wakeAfterExecution = false;
        if (this.timer !== NOT_SET) {
            clearTimeout(this.timer);
        }
        this.timer = NOT_SET;
        this.scheduledAtMs = undefined;
    }

    wake(): void {
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
        const nowMs = Date.now();
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

    private scheduleEngine(delayMs: number): void {
        if (!this.running) {
            return;
        }
        if (this.timer !== NOT_SET) {
            clearTimeout(this.timer);
        }
        const nowMs = Date.now();
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
        const result = await CircuitBreaker.tryToExecute(
            this.circuitBreaker,
            async () => {
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

                return computedDto.totalNumTasksCreated > 0;
            },
            () => true
        );

        return result.fold(
            (error) => {
                if (error.message !== 'Not allowed to execute') {
                    console.error('TaskEngine error', error);
                }
                return false;
            },
            (taskCreated) => taskCreated
        );
    }

    private toTaskPass(task: ComputeAsyncTask.LoopsTaskDto, generation: number): ComputeAsyncTask.LoopsTaskDto {
        return {
            ...task,
            maxConcurrency: async () => this.isCurrentTask(task, generation) ? await task.maxConcurrency() : 0,
            isWork: async () => {
                if (!this.isCurrentTask(task, generation)) {
                    return false;
                }
                const isWork = await task.isWork();
                return isWork && this.isCurrentTask(task, generation);
            },
            runnable: async () => {
                if (this.isCurrentTask(task, generation)) {
                    await task.runnable();
                }
            }
        };
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
        const delayMs = Math.min(
            baseDelayMs * Math.pow(2, this.successiveIdleExecutions - 1),
            maxDelayMs
        );

        return InboxOutboxEngine.withJitter(delayMs);
    }

    private static withJitter(delayMs: number): number {
        const jitterRangeMs = delayMs * InboxOutboxEngine.SCHEDULE_JITTER_RATIO;
        const jitterMs = Math.round((Math.random() * 2 - 1) * jitterRangeMs);

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
