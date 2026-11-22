import type { RallarBlackBoxTestRecipe, RallarBlackBoxTestRecord } from '../../rallar-black-box-test-contracts.ts';

/**
 * A lane runs each role's recipe within an ordinary budget of its own. A cell whose longest step outlasts that budget
 * states the time the step adds in its recipes' metadata, and the lane extends each of those recipes' budget by it.
 */
const ALM_RECIPE_RUN_EXTENSION_KEY = 'almRecipeRunExtensionMs';

export function toAlmRecipeRunExtensionMetadata(extensionMs: number | undefined): RallarBlackBoxTestRecord {
    return extensionMs === undefined ? {} : { [ALM_RECIPE_RUN_EXTENSION_KEY]: extensionMs };
}

/** The recipe's run budget: the lane's ordinary one, extended by what the recipe's metadata states. */
export function computeAlmRecipeRunTimeoutMs(recipe: RallarBlackBoxTestRecipe, ordinaryMs: number): number {
    const extensionMs = recipe.metadata?.[ALM_RECIPE_RUN_EXTENSION_KEY];
    return ordinaryMs + (typeof extensionMs === 'number' ? extensionMs : 0);
}
