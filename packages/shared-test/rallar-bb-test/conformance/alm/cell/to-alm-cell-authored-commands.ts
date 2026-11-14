import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

/**
 * Set by the settled body on each command of a cell's settle: its barriers, the receiver's formation poll and each
 * page's head read and applied wait. Absent, a command is the cell's own: its prologue, its arming run or its body.
 */
const ALM_CELL_SETTLE_METADATA = { cellSettle: 'lane' } as const;

/** The command, declared a command of the cell's settle. */
export function toAlmCellSettleCommand(command: RallarBlackBoxTestCommand): RallarBlackBoxTestCommand {
    return { ...command, metadata: { ...command.metadata, ...ALM_CELL_SETTLE_METADATA } };
}

/**
 * A role recipe's authored commands: every command but its settle's, in recipe order, so a settled recipe yields its
 * prologue then its body exactly as a cell without a settle runs them.
 */
export function toAlmCellAuthoredCommands(
    commands: readonly RallarBlackBoxTestCommand[]
): readonly RallarBlackBoxTestCommand[] {
    return commands.filter((command) => command.metadata?.cellSettle !== ALM_CELL_SETTLE_METADATA.cellSettle);
}
