import type { RallarBlackBoxDistributedRunRecipeSelection } from '../distributed-run.ts';

/** History reads recorded manifests tolerantly, so a selection without a usable recipeId keeps its position. */
export function toDistributedRunRecipeSelectionId(
    selection: Partial<RallarBlackBoxDistributedRunRecipeSelection>,
    index = 0
): string {
    const recipeId = typeof selection.recipeId === 'string' ? selection.recipeId.trim() : '';
    return recipeId.length > 0 ? recipeId : `recipe-${index + 1}`;
}
