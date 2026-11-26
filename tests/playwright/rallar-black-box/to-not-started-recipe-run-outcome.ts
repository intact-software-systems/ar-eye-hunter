import type { RallarBlackBoxTestRecipe } from '../../../packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { toRecipeRunCommandId, type RecipeRunOutcome } from './full-stack-helpers.ts';

/** A recipe the lane held back because a root of its scenario ended not ok first: it never ran, so it never passed. */
export function toNotStartedRecipeRunOutcome(
    recipe: RallarBlackBoxTestRecipe,
    peer: RecipeRunOutcome
): RecipeRunOutcome {
    return {
        commandId: toRecipeRunCommandId(recipe),
        ok: false,
        summary: 'not started',
        cancelledAfter: peer.commandId
    };
}
