import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

/** A recipe's commands with the children of every loop and parallel group, each after its parent, in order. */
export function toNestedCommands(commands: readonly RallarBlackBoxTestCommand[]): readonly RallarBlackBoxTestCommand[] {
    return commands.flatMap((command) => [
        command,
        ...toNestedCommands(
            command.kind === 'loop'
                ? command.commands
                : command.kind === 'parallel'
                ? command.groups.flatMap((group) => group.commands)
                : []
        )
    ]);
}
