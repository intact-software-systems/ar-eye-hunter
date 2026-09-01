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
    private executing = false;
    private wakeAfterExecution = false;
    private successiveIdleExecutions = 0;

    private tasks: Map<string, ComputeAsyncTask.LoopsTaskDto> = new Map<string, ComputeAsyncTask.LoopsTaskDto>();

    includeTask(id: string, task: ComputeAsyncTask.LoopsTaskDto): InboxOutboxEngine {
        this.tasks.set(id, task);
        return this;
    }

    excludeTask(id: string): boolean {
        return this.tasks.delete(id);
    }

    start(): void {
        if (this.running) {
            return;
        }

        this.running = true;
        this.scheduleEngine(0);
    }

    stop(): void {
        this.running = false;
        this.wakeAfterExecution = false;
        if (this.timer !== NOT_SET) {
            clearTimeout(this.timer);
        }
        this.timer = NOT_SET;
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

        if (this.executing) {
            this.wakeAfterExecution = true;
            return;
        }

        this.scheduleEngine(0);
    }

    async executeOnce() {
        return await this.executeTaskEngine();
    }

    private scheduleEngine(delayMs: number): void {
        if (!this.running) {
            return;
        }

        if (this.timer !== NOT_SET) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => void this.selfSchedulingTaskEngine(), delayMs);
    }

    private async selfSchedulingTaskEngine(): Promise<void> {
        if (this.executing) {
            this.wakeAfterExecution = true;
            return;
        }

        this.timer = NOT_SET;
        this.executing = true;
        let taskCreated = false;
        try {
            taskCreated = await this.executeTaskEngine();
        }
        finally {
            this.executing = false;
            if (this.running) {
                const delayMs = this.wakeAfterExecution
                    ? 0
                    : this.nextScheduleDelayMs(taskCreated);
                this.wakeAfterExecution = false;
                this.scheduleEngine(delayMs);
            }
        }
    }

    private async executeTaskEngine() {
        const result = await CircuitBreaker.tryToExecute(
            this.circuitBreaker,
            async () => {
                const computedDto = await ComputeAsyncTask.runLoopsWhileWork(
                    InboxOutboxEngine.toAsyncTaskInput([...this.tasks.values()])
                );

                for (const task of computedDto.tasks) {
                    this.tasks.set(
                        task.inputTask.name,
                        {
                            ...task.inputTask,
                            ongoingTasks: task.tasksInFlight
                        }
                    );
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
