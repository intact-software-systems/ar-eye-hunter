import type { RallarBlackBoxTestRecipe, RallarBlackBoxTestRecord } from '../../rallar-black-box-test-contracts.ts';

/**
 * A lane runs each role's recipe within an ordinary budget of its own. A cell whose longest step outlasts that budget
 * states the time the step adds in its recipes' metadata, and the lane extends each of those recipes' budget by it.
 */
const ALM_RECIPE_RUN_EXTENSION_KEY = 'almRecipeRunExtensionMs';

export function toAlmRecipeRunExtensionMetadata(extensionMs: number | undefined): RallarBlackBoxTestRecord {
    return extensionMs === undefined ? {} : { [ALM_RECIPE_RUN_EXTENSION_KEY]: extensionMs };
}

/**
 * The recipe's run budget: the lane's ordinary one, extended by what the recipe's metadata states. Only a recipe
 * builder writes the key, so a value that is not a non-negative integer of milliseconds is a broken builder.
 */
export function computeAlmRecipeRunTimeoutMs(recipe: RallarBlackBoxTestRecipe, ordinaryMs: number): number {
    const extensionMs = recipe.metadata?.[ALM_RECIPE_RUN_EXTENSION_KEY];
    if (extensionMs === undefined) {
        return ordinaryMs;
    }
    assertAlmRecipeRunExtensionMs(recipe.recipeId, extensionMs);
    return ordinaryMs + extensionMs;
}

function assertAlmRecipeRunExtensionMs(recipeId: string, value: unknown): asserts value is number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(
            `${recipeId} states ${ALM_RECIPE_RUN_EXTENSION_KEY} ${JSON.stringify(value)}, not a non-negative integer.`
        );
    }
}
