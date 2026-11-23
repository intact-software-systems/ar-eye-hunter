import type { RallarBlackBoxDistributedBarrierPolicy } from '../distributed-run.ts';
import type { RallarBlackBoxTestRecipe } from '../rallar-black-box-test-contracts.ts';
import { computeDistributedRunPreambleMs } from './compute-distributed-run-terminal-timeout-seconds.ts';

export interface DistributedRunRootBudgetInput {
    readonly terminalTimeoutSeconds: number;
    readonly ackTimeoutMs: number;
    readonly barrier: RallarBlackBoxDistributedBarrierPolicy;
}

export interface RootBoundTerminalTimeoutInput {
    readonly rootBudgetMs: number;
    readonly ackTimeoutMs: number;
    readonly barrier: RallarBlackBoxDistributedBarrierPolicy;
}

/** A recipe the control server runs as a paired reload root, under the budget it binds from the run's terminal timeout. */
export function isRootBoundDistributedRecipe(recipe: RallarBlackBoxTestRecipe): boolean {
    return Object.hasOwn(recipe.metadata ?? {}, 'almReloadCheckpoints');
}

/** A bound root starts once the run's ack and barrier are over, so it keeps what the terminal timeout leaves after them. */
export function computeDistributedRunRootBudgetMs(input: DistributedRunRootBudgetInput): number {
    return input.terminalTimeoutSeconds * 1_000 - computeDistributedRunPreambleMs(input);
}

/** The terminal timeout that leaves bound roots their budget after the run's ack and barrier. */
export function computeRootBoundTerminalTimeoutSeconds(input: RootBoundTerminalTimeoutInput): number {
    return Math.ceil((computeDistributedRunPreambleMs(input) + input.rootBudgetMs) / 1_000);
}
