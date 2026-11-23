import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

/**
 * The sum of the timeouts `commands` name, one after another: each command's own timeout, and a connect's readiness
 * wait after it, which runs once the connect's own timeout ends. A close contributes the timeout it names, if any. Any
 * other command, and a connect's readiness, must name its own, or `coveredBy`, the wait or lifetime that must outlast
 * the commands, could not cover it.
 */
export function computeCommandsTimeoutMs(commands: readonly RallarBlackBoxTestCommand[], coveredBy: string): number {
    return commands.reduce((sum, command) => {
        if (command.kind === 'close' && command.timeoutMs === undefined) {
            return sum;
        }
        assertCommandTimeoutStated(command, coveredBy);
        return sum + command.timeoutMs + computeReadinessTimeoutMs(command, coveredBy);
    }, 0);
}

/** A connect that names readiness waits for it after its own timeout; a readiness with no timeout waits a default. */
function computeReadinessTimeoutMs(command: RallarBlackBoxTestCommand, coveredBy: string): number {
    if (command.kind !== 'rtc.connect' || command.readiness === undefined) {
        return 0;
    }
    if (command.readiness.timeoutMs === undefined) {
        throw new Error(`${command.commandId ?? command.kind} names no timeout, so ${coveredBy} cannot cover it.`);
    }
    return command.readiness.timeoutMs;
}

function assertCommandTimeoutStated(
    command: RallarBlackBoxTestCommand,
    coveredBy: string
): asserts command is RallarBlackBoxTestCommand & { readonly timeoutMs: number; } {
    if (command.timeoutMs === undefined) {
        throw new Error(`${command.commandId ?? command.kind} names no timeout, so ${coveredBy} cannot cover it.`);
    }
}
