import type { RallarBlackBoxTestCommand, RallarBlackBoxTestRecipe } from '../rallar-black-box-test-contracts.ts';
import { snapshotComparisonValue } from './snapshot-comparison-value.ts';

/** Captures executable structure and capture options. Opaque application payloads retain their semantics. */
export function snapshotExecutableRecipe(recipe: RallarBlackBoxTestRecipe): RallarBlackBoxTestRecipe {
    return Object.freeze({ ...recipe, commands: Object.freeze(recipe.commands.map(snapshotExecutableCommand)) });
}

export function snapshotExecutableCommand(command: RallarBlackBoxTestCommand): RallarBlackBoxTestCommand {
    switch (command.kind) {
        case 'recipe.load':
            return Object.freeze({ ...command, recipe: snapshotExecutableRecipe(command.recipe) });
        case 'recipe.run':
            return Object.freeze({ ...command, recipe: command.recipe && snapshotExecutableRecipe(command.recipe) });
        case 'loop':
            return Object.freeze({
                ...command,
                commands: Object.freeze(command.commands.map(snapshotExecutableCommand))
            });
        case 'parallel':
            return Object.freeze({
                ...command,
                groups: Object.freeze(command.groups.map((group) =>
                    Object.freeze({
                        ...group,
                        commands: Object.freeze(group.commands.map(snapshotExecutableCommand))
                    })
                ))
            });
        case 'configure':
            return Object.freeze({
                ...command,
                config: Object.freeze({
                    ...command.config,
                    rallar: command.config.rallar && Object.freeze({ ...command.config.rallar })
                })
            });
        case 'rtc.connect':
            return Object.freeze({ ...command, rallar: command.rallar && Object.freeze({ ...command.rallar }) });
        case 'wait':
            return Object.freeze({ ...command, match: snapshotComparisonValue(command.match) });
        default:
            return Object.freeze({ ...command });
    }
}
