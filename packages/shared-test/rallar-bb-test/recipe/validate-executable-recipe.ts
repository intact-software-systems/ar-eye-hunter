import type { RallarBlackBoxTestCommand, RallarBlackBoxTestRecipe } from '../rallar-black-box-test-contracts.ts';
import { validateCommandCaptureSelection } from './validate-command-capture-selection.ts';

import { validateRecipeFields } from './validate-recipe-fields.ts';

export function validateExecutableRecipe(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    const commands: readonly RallarBlackBoxTestCommand[] = Array.isArray(recipe.commands) ? recipe.commands : [];
    const issues = [
        ...validateRecipeFields({ ...recipe }, 'Recipe').map((issue) => issue.message),
        ...(recipe.recipeId ? [] : ['Recipe requires recipeId.']),
        ...(commands.length > 0 ? [] : ['Recipe requires at least one command.']),
        ...commands.flatMap(validateExecutableCommand)
    ];
    return [...new Set(issues)];
}

/** Validates only executable children; application payloads are outside this typed boundary. */
export function validateExecutableCommand(command: RallarBlackBoxTestCommand): readonly string[] {
    const issues = [...validateCommandCaptureSelection({ ...command })];
    switch (command.kind) {
        case 'recipe.load':
        case 'recipe.run':
            if (command.recipe !== undefined) {
                issues.push(...validateExecutableRecipe(command.recipe));
            }
            break;
        case 'loop':
            issues.push(...(command.commands ?? []).flatMap(validateExecutableCommand));
            break;
        case 'parallel':
            for (const group of command.groups ?? []) {
                issues.push(...(group.commands ?? []).flatMap(validateExecutableCommand));
            }
            break;
    }
    return issues;
}
