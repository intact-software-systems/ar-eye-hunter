import type { RallarBlackBoxDistributedBarrierPolicy } from '../distributed-run.ts';
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

/** A bound root gets the run's terminal timeout less the ack and barrier the derived terminal timeout counts first. */
export function computeDistributedRunRootBudgetMs(input: DistributedRunRootBudgetInput): number {
    return input.terminalTimeoutSeconds * 1_000 - computeDistributedRunPreambleMs(input);
}

/** The terminal timeout under which bound roots get the given budget. */
export function computeRootBoundTerminalTimeoutSeconds(input: RootBoundTerminalTimeoutInput): number {
    return Math.ceil((computeDistributedRunPreambleMs(input) + input.rootBudgetMs) / 1_000);
}
