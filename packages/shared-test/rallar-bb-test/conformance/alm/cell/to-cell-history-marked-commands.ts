import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../alm-conformance-step-identities.ts';

/**
 * Starts every wait of the commands, nested ones included, at the first event of any of its own cell's commands, so no
 * wait reads an event an earlier cell left on the same page. The mark opens at that first event, which can come before
 * the command's result. The one exception, declared `historyFrom: 'page'` in the wait's metadata, is a store's recovery
 * that a fresh document reports during its first connect, pinned to that connect's session, so no earlier cell's
 * recovery can match it. Any other wait must follow at least one of its cell's own commands.
 */
export function toCellHistoryMarkedCommands(
    step: AlmConformanceStepInput,
    commands: readonly RallarBlackBoxTestCommand[]
): readonly RallarBlackBoxTestCommand[] {
    const sinceCommandIdPrefix = toCommandId(step, '');
    return commands.map((command) => toCellHistoryMarkedCommand(command, sinceCommandIdPrefix));
}

function toCellHistoryMarkedCommand(
    command: RallarBlackBoxTestCommand,
    sinceCommandIdPrefix: string
): RallarBlackBoxTestCommand {
    const toMarked = (child: RallarBlackBoxTestCommand) => toCellHistoryMarkedCommand(child, sinceCommandIdPrefix);
    switch (command.kind) {
        case 'wait':
            return command.metadata?.historyFrom === 'page'
                ? command
                : { ...command, match: { ...command.match, sinceCommandIdPrefix } };
        case 'loop':
            return { ...command, commands: command.commands.map(toMarked) };
        case 'parallel':
            return {
                ...command,
                groups: command.groups.map((group) => ({ ...group, commands: group.commands.map(toMarked) }))
            };
        default:
            return command;
    }
}
