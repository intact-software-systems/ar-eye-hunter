import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRuntime
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { toNestedCommands } from './to-nested-commands.ts';

/**
 * Records, for every cell whose history mark the commands' waits carry, the result of that cell's first command, as a
 * page does before the cell's body runs. Events written afterwards are then each cell's own history. A fixture that
 * runs one role to its end before the next uses it to open the later role's cells first, as the lane's prologue and
 * barriers do. Commands with no marked wait read the page's history, so nothing is recorded for them.
 */
export function writeAlmCellStartEvents(
    runtime: Pick<RallarBlackBoxTestRuntime, 'recordEvent'>,
    commands: readonly RallarBlackBoxTestCommand[]
): void {
    const cellPrefixes = new Set(
        toNestedCommands(commands).flatMap((command) =>
            command.kind === 'wait' && command.match.sinceCommandIdPrefix !== undefined
                ? [command.match.sinceCommandIdPrefix]
                : []
        )
    );
    for (const cellPrefix of cellPrefixes) {
        runtime.recordEvent({
            kind: 'result',
            topic: 'rallar.bb.command.result',
            commandId: `${cellPrefix}ensure-group`,
            severity: 'info',
            payload: {}
        });
    }
}
