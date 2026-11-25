import { computeDistributedRunTerminalTimeoutSeconds } from '../distributed-recipe-targeting/compute-distributed-run-terminal-timeout-seconds.ts';
import type { RallarBlackBoxTestCommand } from '../rallar-black-box-test-contracts.ts';
import { computeRtcConnectReadinessTimeoutMs } from '../recipe/compute-rtc-connect-readiness-timeout-ms.ts';

import { CONTROL_REQUEST_TIMEOUT_MS } from './control-request-timeout-ms.ts';

/**
 * How long a harness waits on a command in all: its enqueue request under the control request timeout, then its poll
 * for the result, which lasts what the command may take and then the harness's own poll margin.
 */
export function computeCommandResultWaitMs(command: RallarBlackBoxTestCommand, pollMarginMs: number): number {
    return computeCommandWaitMs(computeCommandResultPollTimeoutMs(command, pollMarginMs));
}

/**
 * How long a harness polls for a command's result once it is enqueued: what the command may take, then the harness's
 * own poll margin for the result to reach the control server and be read.
 */
export function computeCommandResultPollTimeoutMs(command: RallarBlackBoxTestCommand, pollMarginMs: number): number {
    return computeCommandBudgetMs(command) + pollMarginMs;
}

/** A command whose result poll is known waits its enqueue request under the control request timeout, then that poll. */
export function computeCommandWaitMs(resultPollTimeoutMs: number): number {
    return CONTROL_REQUEST_TIMEOUT_MS + resultPollTimeoutMs;
}

/**
 * A recipe root that names no timeout of its own may take its commands' budgets end to end; any other command its own
 * timeout and, for a connect, the readiness wait that runs after it.
 */
function computeCommandBudgetMs(command: RallarBlackBoxTestCommand): number {
    if (command.kind === 'recipe.run' && command.timeoutMs === undefined && command.recipe !== undefined) {
        return computeDistributedRunTerminalTimeoutSeconds({
            recipes: [command.recipe],
            ackTimeoutMs: 0,
            barrier: { enabled: false }
        }) * 1_000;
    }
    return (command.timeoutMs ?? 0) + computeRtcConnectReadinessTimeoutMs(command);
}
