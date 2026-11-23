import { computeDistributedRunTerminalTimeoutSeconds } from '@shared-test/rallar-bb-test/distributed-recipe-targeting/compute-distributed-run-terminal-timeout-seconds.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { computeRtcConnectReadinessTimeoutMs } from '@shared-test/rallar-bb-test/recipe/compute-rtc-connect-readiness-timeout-ms.ts';

/**
 * How long a harness waits for a command's result: what the command may take, then the harness's own poll margin for
 * the result to reach the control server and be read.
 */
export function computeCommandResultWaitMs(command: RallarBlackBoxTestCommand, pollMarginMs: number): number {
    return computeCommandBudgetMs(command) + pollMarginMs;
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
