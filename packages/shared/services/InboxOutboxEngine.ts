import * as ComputeAsyncTask from "../resilience/ComputeAsyncTask.ts";
import {CircuitBreaker, CircuitBreakerPolicy} from "../resilience/Resilience.ts";

const NOT_SET = -1;

export class InboxOutboxEngine {
    private static readonly defaultDuration: Temporal.Duration = Temporal.Duration.from({seconds: 10})
    private static readonly defaultSlidingWindowDuration: Temporal.Duration = Temporal.Duration.from({minutes: 10})
    private static readonly circuitBreakerPolicy: CircuitBreakerPolicy =
        new CircuitBreakerPolicy(
            10,
            InboxOutboxEngine.defaultDuration,
            InboxOutboxEngine.defaultDuration,
            InboxOutboxEngine.defaultSlidingWindowDuration
        )
    private static readonly circuitBreaker: CircuitBreaker = CircuitBreaker.create(InboxOutboxEngine.circuitBreakerPolicy)

    private static readonly MAX_BACKOFF: Temporal.Duration = Temporal.Duration.from({seconds: 1})
    private static readonly MAX_IS_WORK_CHECKS: number = 1000;
    private static readonly MAX_SUCCESSIVE_NO_TASKS_CREATED: number = 10;
    private static readonly FIXED_DELAY_SCHEDULED_ENGINE: Temporal.Duration = Temporal.Duration.from({seconds: 1})

    private running = false;
    private timer: number = NOT_SET;

    private tasks: Map<string, ComputeAsyncTask.Loops.TaskDto> = new Map<string, ComputeAsyncTask.Loops.TaskDto>();

    includeTask(id: string, task: ComputeAsyncTask.Loops.TaskDto): InboxOutboxEngine {
        this.tasks.set(id, task);
        return this;
    }

    excludeTask(id: string): boolean {
        return this.tasks.delete(id)
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
        return await this.executeTaskEngine()
    }


    private scheduleEngine(delayMs: number): void {
        this.timer = self.setTimeout(() => void this.selfSchedulingTaskEngine(), delayMs);
    }

    private async selfSchedulingTaskEngine(): Promise<void> {
        try {
            await this.executeTaskEngine();
        } finally {
            this.scheduleEngine(InboxOutboxEngine.FIXED_DELAY_SCHEDULED_ENGINE.total({unit: "milliseconds"}));
        }
    }

    private async executeTaskEngine() {
        return await CircuitBreaker.tryToExecuteBooleanSupplier(
            InboxOutboxEngine.circuitBreaker,
            async () => {
                try {
                    const computedDto =
                        await ComputeAsyncTask.Loops.runWhileWork(
                            InboxOutboxEngine.toAsyncTaskInput([...this.tasks.values()])
                        )

                    this.tasks =
                        new Map(
                            computedDto.tasks
                                .map(
                                    t =>
                                        [t.inputTask.name, t.inputTask]
                                )
                        )

                    return computedDto.totalNumTasksCreated > 0;
                } catch (e) {
                    console.error("TaskEngine error", e);
                    return false
                }
            }
        )
    }

    private static toAsyncTaskInput(
        tasks: readonly ComputeAsyncTask.Loops.TaskDto[],
    ) {
        return {
            tasks: tasks,
            maxBackoffMs: InboxOutboxEngine.MAX_BACKOFF.total({unit: "milliseconds"}),
            maxIsWorkIterations: InboxOutboxEngine.MAX_IS_WORK_CHECKS,
            maxSuccessiveNoTasksCreated: InboxOutboxEngine.MAX_SUCCESSIVE_NO_TASKS_CREATED
        }
    }
}
