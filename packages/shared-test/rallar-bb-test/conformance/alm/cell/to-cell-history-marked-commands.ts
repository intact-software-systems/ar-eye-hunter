import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestWaitCommand
} from '../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../alm-conformance-step-identities.ts';
import { toAlmCellCommandPrefix } from './to-alm-cell-command-prefix.ts';

/**
 * Starts every wait of the commands, nested ones included, at the first event of any of its own cell's commands, so no
 * wait reads an event an earlier cell left on the same page. The mark opens at that first event, which can come before
 * the command's result. A wait that already names its own start keeps it, and that start must be a command of its own
 * cell: any other is a programmer error, thrown naming the wait. A wait that declares `historyFrom: 'page'` in its
 * metadata reads the page's whole history, in two classes: a store's recovery that a fresh document reports during its
 * first connect, pinned to that connect's session, so no earlier cell's recovery can match it; and the settle's wait for
 * the room's head, which matches only `held` applications at or above the head's revisions: every settle role's connect
 * in the cell wrote presence before the head read, so its `presenceRevision` floor is above any `held` event an earlier
 * cell left, and `removed` events are not matched. Any other wait must follow at least one of its cell's own commands.
 */
export function toCellHistoryMarkedCommands(
    step: AlmConformanceStepInput,
    commands: readonly RallarBlackBoxTestCommand[]
): readonly RallarBlackBoxTestCommand[] {
    const own = {
        sinceCommandIdPrefix: toCommandId(step, ''),
        ownRolePrefixes: step.roles.map((role) =>
            `${toAlmCellCommandPrefix(step.input.carrier, step.scenarioKey)}-${role}-`
        )
    };
    return commands.map((command) => toCellHistoryMarkedCommand(command, own));
}

interface OwnCellStart {
    readonly sinceCommandIdPrefix: string;
    readonly ownRolePrefixes: readonly string[];
}

function toCellHistoryMarkedCommand(command: RallarBlackBoxTestCommand, own: OwnCellStart): RallarBlackBoxTestCommand {
    const toMarked = (child: RallarBlackBoxTestCommand) => toCellHistoryMarkedCommand(child, own);
    switch (command.kind) {
        case 'wait':
            return command.metadata?.historyFrom === 'page' ? command : toMarkedWait(command, own);
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

function toMarkedWait(wait: RallarBlackBoxTestWaitCommand, own: OwnCellStart): RallarBlackBoxTestWaitCommand {
    const named = wait.match.sinceCommandIdPrefix;
    assertStartInOwnCell(wait, named, own.ownRolePrefixes);
    return { ...wait, match: { ...wait.match, sinceCommandIdPrefix: named ?? own.sinceCommandIdPrefix } };
}

function assertStartInOwnCell(
    wait: RallarBlackBoxTestWaitCommand,
    named: string | undefined,
    ownRolePrefixes: readonly string[]
): void {
    if (named !== undefined && !ownRolePrefixes.some((prefix) => named.startsWith(prefix))) {
        throw new Error(
            `Wait ${wait.commandId} starts its history at ${named}, which is not a command of its own cell.`
        );
    }
}
