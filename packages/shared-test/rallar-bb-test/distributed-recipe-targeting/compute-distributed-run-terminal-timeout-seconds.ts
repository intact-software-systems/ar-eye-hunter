import type { RallarBlackBoxDistributedBarrierPolicy } from '../distributed-run.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestLoopCommand,
    RallarBlackBoxTestParallelCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRtcStreamCommand
} from '../rallar-black-box-test-contracts.ts';
import {
    computeRallarBlackBoxRtcStreamPlan,
    RALLAR_BLACK_BOX_RTC_STREAM_DEFAULT_DRAIN_TIMEOUT_MS
} from '../rtc-stream.ts';

export interface DistributedRunTerminalTimeoutInput {
    /** The recipes the run's agents execute side by side; the slowest one bounds the run. */
    readonly recipes: readonly RallarBlackBoxTestRecipe[];
    readonly ackTimeoutMs: number;
    readonly barrier: RallarBlackBoxDistributedBarrierPolicy;
}

/**
 * The longest a distributed run can take when the agents acknowledge, meet at the barrier and then run the slowest
 * recipe with every command using its whole budget, rounded up to the second the terminal wait counts in.
 */
export function computeDistributedRunTerminalTimeoutSeconds(input: DistributedRunTerminalTimeoutInput): number {
    const barrierTimeoutMs = input.barrier.enabled ? input.barrier.timeoutMs : 0;
    const slowestRecipeMs = Math.max(0, ...input.recipes.map((recipe) => computeCommandsBudgetMs(recipe.commands)));
    return Math.ceil((input.ackTimeoutMs + barrierTimeoutMs + slowestRecipeMs) / 1_000);
}

function computeCommandsBudgetMs(commands: readonly RallarBlackBoxTestCommand[]): number {
    return commands.reduce((sum, command) => sum + computeCommandBudgetMs(command), 0);
}

/**
 * A command's own timeout bounds it. Without one, a loop, a parallel block and a stream are bounded by their schedule;
 * any other command, such as stats or an assertion, reads local state and adds no budget.
 */
function computeCommandBudgetMs(command: RallarBlackBoxTestCommand): number {
    if (command.timeoutMs !== undefined) {
        return command.timeoutMs;
    }
    switch (command.kind) {
        case 'loop':
            return computeLoopBudgetMs(command);
        case 'parallel':
            return computeParallelBudgetMs(command);
        case 'rtc.stream':
            return computeStreamBudgetMs(command);
        default:
            return 0;
    }
}

/** Every iteration runs its children, and the loop pauses one interval between iterations. */
function computeLoopBudgetMs(command: RallarBlackBoxTestLoopCommand): number {
    assertLoopHasNoBackoff(command);
    const iterationBudgetMs = computeCommandsBudgetMs(command.commands);
    const intervalMs = command.intervalMs ?? command.delayMs ?? 0;
    if (command.durationMs !== undefined) {
        return command.durationMs + iterationBudgetMs;
    }
    const count = command.count ?? 1;
    return (count - 1) * intervalMs + count * iterationBudgetMs;
}

function assertLoopHasNoBackoff(command: RallarBlackBoxTestLoopCommand): void {
    if (command.backoffMultiplier !== undefined && command.backoffMultiplier !== 1) {
        throw new Error(`Loop ${command.commandId ?? ''} backs off, so its pauses have no fixed budget.`);
    }
}

/** Groups run side by side up to the concurrency limit; below it, they may run one after another. */
function computeParallelBudgetMs(command: RallarBlackBoxTestParallelCommand): number {
    const groupBudgetsMs = command.groups.map((group) => computeCommandsBudgetMs(group.commands));
    const runsSideBySide = command.maxConcurrency === undefined || command.maxConcurrency >= command.groups.length;
    return runsSideBySide
        ? Math.max(0, ...groupBudgetsMs)
        : groupBudgetsMs.reduce((sum, budgetMs) => sum + budgetMs, 0);
}

/** The last frame leaves on its schedule, then the stream waits up to its drain timeout for the frames in flight. */
function computeStreamBudgetMs(command: RallarBlackBoxTestRtcStreamCommand): number {
    const plan = computeRallarBlackBoxRtcStreamPlan({
        count: command.count,
        durationMs: command.durationMs,
        intervalMs: command.intervalMs,
        rateHz: command.rateHz
    });
    const lastFrameMs = plan.frames.at(-1)?.scheduledElapsedMs ?? 0;
    return lastFrameMs + (command.drainTimeoutMs ?? RALLAR_BLACK_BOX_RTC_STREAM_DEFAULT_DRAIN_TIMEOUT_MS);
}
