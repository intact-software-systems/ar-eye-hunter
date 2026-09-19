import type { RallarBlackBoxTestCommand, RallarBlackBoxTestRecipe } from '../rallar-black-box-test-contracts.ts';

import { validateRecipeFields } from './validate-recipe-fields.ts';

export function validateExecutableRecipe(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    const commands: readonly RallarBlackBoxTestCommand[] = Array.isArray(recipe.commands) ? recipe.commands : [];
    const issues = [
        ...validateRecipeFields({ ...recipe }, 'Recipe').map((issue) => issue.message),
        ...(recipe.recipeId ? [] : ['Recipe requires recipeId.']),
        ...(commands.length > 0 ? [] : ['Recipe requires at least one command.']),
        ...validateInlineRecipes(commands)
    ];
    return [...new Set(issues)];
}

function validateInlineRecipes(commands: readonly RallarBlackBoxTestCommand[]): readonly string[] {
    return commands.flatMap((command) => {
        switch (command.kind) {
            case 'recipe.load':
            case 'recipe.run':
                return command.recipe === undefined ? [] : validateExecutableRecipe(command.recipe);
            case 'loop':
                return validateInlineRecipes(command.commands ?? []);
            case 'parallel':
                return validateInlineRecipes((command.groups ?? []).flatMap((group) => group.commands ?? []));
            default:
                return [];
        }
    });
}
