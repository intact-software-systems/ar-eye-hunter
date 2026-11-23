import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

/**
 * The longest `commands` may take one after another: each command's own timeout, and a connect's readiness wait after
 * it, which runs once the connect's own timeout ends. A close that names no timeout adds none; any other command must
 * name its own, or `coveredBy`, the wait or lifetime that must outlast the commands, could not cover it.
 */
export function computeCommandsTimeoutMs(commands: readonly RallarBlackBoxTestCommand[], coveredBy: string): number {
    return commands.reduce((sum, command) => {
        if (command.kind === 'close' && command.timeoutMs === undefined) {
            return sum;
        }
        assertCommandTimeoutStated(command, coveredBy);
        const readinessMs = command.kind === 'rtc.connect' ? command.readiness?.timeoutMs ?? 0 : 0;
        return sum + command.timeoutMs + readinessMs;
    }, 0);
}

function assertCommandTimeoutStated(
    command: RallarBlackBoxTestCommand,
    coveredBy: string
): asserts command is RallarBlackBoxTestCommand & { readonly timeoutMs: number; } {
    if (command.timeoutMs === undefined) {
        throw new Error(`${command.commandId ?? command.kind} names no timeout, so ${coveredBy} cannot cover it.`);
    }
}
