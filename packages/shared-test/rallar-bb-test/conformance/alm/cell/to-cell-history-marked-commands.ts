import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestWaitCommand
} from '../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../alm-conformance-step-identities.ts';
import { toAlmCellCommandPrefix } from './to-alm-cell-command-prefix.ts';

/** Where a wait of a cell reads from: `cell`, its own cell's first event on the page; `page`, the page's whole history. */
export type AlmWaitHistory = 'cell' | 'page';

/** The metadata a wait declares for its history: only `page` is declared, since every other wait reads its cell's. */
export function toWaitHistoryMetadata(
    history: AlmWaitHistory
): Readonly<{ metadata?: Readonly<{ historyFrom: 'page'; }>; }> {
    return history === 'page' ? { metadata: { historyFrom: 'page' } } : {};
}

/**
 * Starts every wait of the commands, nested ones included, at the first event of any of its own cell's commands, so no
 * wait reads an event an earlier cell left on the same page. The mark opens at that first event, which can come before
 * the command's result. A wait that already names its own start keeps it, and that start must be a command of its own
 * cell: any other is a programmer error, thrown naming the wait. A wait that declares `historyFrom: 'page'` in its
 * metadata reads the page's whole history, in two classes: a store's recovery that a fresh document reports during
 * its first connect, pinned to that connect's session, so no earlier cell's recovery can match it; and the settle's wait
 * for the room's head, which matches only `held` applications at or above the head's revisions: in a room per cell no
 * earlier cell left one, while in a room the family shares an earlier cell's last `held` event can sit at the head's
 * revisions, since a connect's presence write advances `presenceRevision` only when the room's presence-summary work
 * runs, and `removed` events are not matched. Any other wait must follow at least one of its cell's own commands.
 */
export function toCellHistoryMarkedCommands(
    step: AlmConformanceStepInput,
    commands: readonly RallarBlackBoxTestCommand[]
): readonly RallarBlackBoxTestCommand[] {
    const cellPrefix = toAlmCellCommandPrefix(step.input.carrier, step.scenarioKey);
    const own = {
        cellPrefix,
        sinceCommandIdPrefix: toCommandId(step, ''),
        ownRolePrefixes: step.roles.map((role) => toCommandId({ ...step, role }, ''))
    };
    return commands.map((command) => toCellHistoryMarkedCommand(command, own));
}

interface OwnCellStart {
    readonly cellPrefix: string;
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
    assertStartInOwnCell(wait, named, own);
    return { ...wait, match: { ...wait.match, sinceCommandIdPrefix: named ?? own.sinceCommandIdPrefix } };
}

function assertStartInOwnCell(
    wait: RallarBlackBoxTestWaitCommand,
    named: string | undefined,
    own: OwnCellStart
): void {
    if (named !== undefined && !own.ownRolePrefixes.some((prefix) => named.startsWith(prefix))) {
        throw new Error(
            `Wait ${wait.commandId} of cell ${own.cellPrefix} starts its history at ${named}, ` +
                'which is not a command of its own cell.'
        );
    }
}
