import { Temporal } from '@js-temporal/polyfill';
import * as ComputeAsyncTask from '../resilience/ComputeAsyncTask.ts';
import { CircuitBreaker, CircuitBreakerPolicy } from '../resilience/Resilience.ts';

const NOT_SET = -1;

export class InboxOutboxEngine {
    private static readonly MAX_BACKOFF: Temporal.Duration = Temporal.Duration.from({ seconds: 1 });
    private static readonly MAX_IS_WORK_CHECKS: number = 10_000;
    private static readonly MAX_SUCCESSIVE_NO_TASKS_CREATED: number = 10;
    private static readonly FIXED_DELAY_SCHEDULED_ENGINE: Temporal.Duration = Temporal.Duration.from({ seconds: 1 });
    private static readonly MAX_IDLE_SCHEDULED_ENGINE: Temporal.Duration = Temporal.Duration.from({ seconds: 30 });
    private static readonly SCHEDULE_JITTER_RATIO = 0.2;

    private static readonly defaultDuration: Temporal.Duration = Temporal.Duration.from({ seconds: 10 });
    private static readonly defaultSlidingWindowDuration: Temporal.Duration = Temporal.Duration.from({ minutes: 1 });
    private static readonly circuitBreakerPolicy: CircuitBreakerPolicy =
        new CircuitBreakerPolicy(
            10,
            InboxOutboxEngine.defaultDuration,
            InboxOutboxEngine.defaultDuration,
            InboxOutboxEngine.defaultSlidingWindowDuration,
        );

    private readonly circuitBreaker: CircuitBreaker = CircuitBreaker.create(InboxOutboxEngine.circuitBreakerPolicy);

    private running = false;
    private timer: number = NOT_SET;
    private successiveIdleExecutions = 0;

    private tasks: Map<string, ComputeAsyncTask.Loops.TaskDto> = new Map<string, ComputeAsyncTask.Loops.TaskDto>();

    includeTask(id: string, task: ComputeAsyncTask.Loops.TaskDto): InboxOutboxEngine {
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
        if (this.timer !== NOT_SET) {
            clearTimeout(this.timer);
        }
        this.timer = NOT_SET;
    }

    async executeOnce() {
        return await this.executeTaskEngine();
    }


    private scheduleEngine(delayMs: number): void {
        if (!this.running) {
            return;
        }

        this.timer = self.setTimeout(() => void this.selfSchedulingTaskEngine(), delayMs);
    }

    private async selfSchedulingTaskEngine(): Promise<void> {
        this.timer = NOT_SET;
        let taskCreated = false;
        try {
            taskCreated = await this.executeTaskEngine();
        } finally {
            if (this.running) {
                this.scheduleEngine(this.nextScheduleDelayMs(taskCreated));
            }
        }
    }

    private async executeTaskEngine() {
        const result = await CircuitBreaker.tryToExecute(
            this.circuitBreaker,
            async () => {

                const computedDto = await ComputeAsyncTask.Loops.runWhileWork(
                    InboxOutboxEngine.toAsyncTaskInput([...this.tasks.values()]),
                );

                for (const task of computedDto.tasks) {
                    this.tasks.set(
                        task.inputTask.name,
                        {
                            ...task.inputTask,
                            ongoingTasks: task.tasksInFlight,
                        }
                    );
                }

                return computedDto.totalNumTasksCreated > 0;
            },
            () => true,
        );

        return result.fold(
            (error) => {
                if (error.message !== 'Not allowed to execute') {
                    console.error('TaskEngine error', error);
                }
                return false;
            },
            (taskCreated) => taskCreated,
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
            maxDelayMs,
        );

        return InboxOutboxEngine.withJitter(delayMs);
    }

    private static withJitter(delayMs: number): number {
        const jitterRangeMs = delayMs * InboxOutboxEngine.SCHEDULE_JITTER_RATIO;
        const jitterMs = Math.round((Math.random() * 2 - 1) * jitterRangeMs);

        return Math.max(0, delayMs + jitterMs);
    }

    private static toAsyncTaskInput(
        tasks: readonly ComputeAsyncTask.Loops.TaskDto[],
    ) {
        return {
            tasks: tasks,
            maxBackoffMs: InboxOutboxEngine.MAX_BACKOFF.total({ unit: 'milliseconds' }),
            maxIsWorkIterations: InboxOutboxEngine.MAX_IS_WORK_CHECKS,
            maxSuccessiveNoTasksCreated: InboxOutboxEngine.MAX_SUCCESSIVE_NO_TASKS_CREATED
        };
    }
}
