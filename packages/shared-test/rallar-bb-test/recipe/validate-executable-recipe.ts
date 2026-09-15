import type { RallarBlackBoxTestCommand, RallarBlackBoxTestRecipe } from '../rallar-black-box-test-contracts.ts';

const RECIPE_VERSION_ISSUE = 'Recipe schemaVersion must be 1.';

export function validateExecutableRecipe(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    const commands: readonly RallarBlackBoxTestCommand[] = Array.isArray(recipe.commands) ? recipe.commands : [];
    const issues = [
        ...(recipe.schemaVersion === 1 ? [] : [RECIPE_VERSION_ISSUE]),
        ...(recipe.recipeId ? [] : ['Recipe requires recipeId.']),
        ...(commands.length > 0 ? [] : ['Recipe requires at least one command.']),
        ...validateInlineRecipeVersions(commands)
    ];
    return [...new Set(issues)];
}

function validateInlineRecipeVersions(commands: readonly RallarBlackBoxTestCommand[]): readonly string[] {
    return commands.flatMap((command) => {
        switch (command.kind) {
            case 'recipe.load':
            case 'recipe.run':
                return command.recipe === undefined ? [] : validateInlineRecipe(command.recipe);
            case 'loop':
                return validateInlineRecipeVersions(command.commands ?? []);
            case 'parallel':
                return validateInlineRecipeVersions((command.groups ?? []).flatMap((group) => group.commands ?? []));
            default:
                return [];
        }
    });
}

function validateInlineRecipe(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    return [
        ...(recipe.schemaVersion === 1 ? [] : [RECIPE_VERSION_ISSUE]),
        ...validateInlineRecipeVersions(Array.isArray(recipe.commands) ? recipe.commands : [])
    ];
}
