import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';
import { computeRtcConnectReadinessTimeoutMs } from '../../../recipe/compute-rtc-connect-readiness-timeout-ms.ts';

/**
 * The sum of the timeouts `commands` name, one after another: each command's own timeout, and a connect's readiness
 * wait after it, which runs once the connect completed, under its own timeout. A close contributes the timeout it
 * names, if any. Any other command, and a connect's readiness, must name its own, or `coveredBy`, the wait or lifetime
 * that must outlast the commands, could not cover it.
 */
export function computeCommandsTimeoutMs(commands: readonly RallarBlackBoxTestCommand[], coveredBy: string): number {
    return commands.reduce((sum, command) => {
        if (command.kind === 'close' && command.timeoutMs === undefined) {
            return sum;
        }
        assertCommandTimeoutStated(command, coveredBy);
        assertReadinessTimeoutStated(command, coveredBy);
        return sum + command.timeoutMs + computeRtcConnectReadinessTimeoutMs(command);
    }, 0);
}

/** A readiness with no timeout of its own waits the runtime's default, which no recipe of a cell may leave unstated. */
function assertReadinessTimeoutStated(command: RallarBlackBoxTestCommand, coveredBy: string): void {
    if (
        command.kind === 'rtc.connect' && command.readiness !== undefined && command.readiness.timeoutMs === undefined
    ) {
        throw new Error(
            `${command.commandId ?? command.kind}'s readiness names no timeout, so ${coveredBy} cannot cover it.`
        );
    }
}

function assertCommandTimeoutStated(
    command: RallarBlackBoxTestCommand,
    coveredBy: string
): asserts command is RallarBlackBoxTestCommand & { readonly timeoutMs: number; } {
    if (command.timeoutMs === undefined) {
        throw new Error(`${command.commandId ?? command.kind} names no timeout, so ${coveredBy} cannot cover it.`);
    }
}
