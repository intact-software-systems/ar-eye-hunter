import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult
} from '../rallar-black-box-test-contracts.ts';
import { toBoundedDeadlineCommand } from '../runtime/to-runtime-command-values.ts';

export interface RecipeCommandsPorts {
    readonly now: () => number;
    readonly runChildCommand: (command: RallarBlackBoxTestCommand) => Promise<RallarBlackBoxTestResult>;
    readonly cancelRequested: () => boolean;
}

export interface RunRecipeCommandsInput {
    readonly recipe: RallarBlackBoxTestRecipe;
    /** The recipe.run command's own timeout, reported when the deadline passes. */
    readonly timeoutMs: number | undefined;
    /** Absent when neither the recipe.run command nor its parent sets a deadline. */
    readonly deadlineEpochMs?: number;
    readonly ports: RecipeCommandsPorts;
}

export const RALLAR_BLACK_BOX_RECIPE_TIMEOUT = 'RALLAR_BLACK_BOX_RECIPE_TIMEOUT';

export async function runRecipeCommands(input: RunRecipeCommandsInput): Promise<RallarBlackBoxTestCommandOutcome> {
    const { recipe, deadlineEpochMs, ports } = input;
    const results: RallarBlackBoxTestResult[] = [];
    for (const child of recipe.commands) {
        if (ports.cancelRequested()) {
            return toCancelledRecipeOutcome(recipe, results);
        }
        if (deadlineEpochMs !== undefined && ports.now() >= deadlineEpochMs) {
            return toTimedOutRecipeOutcome(input, results);
        }
        const command = deadlineEpochMs === undefined ? child : toBoundedDeadlineCommand(child, deadlineEpochMs);
        const result = await ports.runChildCommand(command);
        results.push(result);
        if (ports.cancelRequested() || result.status === 'cancelled') {
            return toCancelledRecipeOutcome(recipe, results);
        }
        if (!result.ok && recipe.continueOnFailure !== true) {
            return toFailedRecipeOutcome(recipe, results, result);
        }
    }
    return { status: 'ok', value: { recipeId: recipe.recipeId, results }, nextStatus: 'completed' };
}

function toCancelledRecipeOutcome(
    recipe: RallarBlackBoxTestRecipe,
    results: readonly RallarBlackBoxTestResult[]
): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'cancelled',
        value: { recipeId: recipe.recipeId, results, cancelled: true },
        nextStatus: 'cancelled'
    };
}

function toFailedRecipeOutcome(
    recipe: RallarBlackBoxTestRecipe,
    results: readonly RallarBlackBoxTestResult[],
    failed: RallarBlackBoxTestResult
): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'failed',
        value: { recipeId: recipe.recipeId, results },
        nextStatus: 'failed',
        error: {
            code: 'RALLAR_BLACK_BOX_RECIPE_FAILED',
            message: 'Recipe failed at command ' + failed.commandId + '.',
            details: failed.error
        }
    };
}

function toTimedOutRecipeOutcome(
    input: RunRecipeCommandsInput,
    results: readonly RallarBlackBoxTestResult[]
): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'failed',
        value: { recipeId: input.recipe.recipeId, results, timedOut: true },
        error: {
            code: RALLAR_BLACK_BOX_RECIPE_TIMEOUT,
            message: 'Recipe reached its timeout before all commands completed.',
            details: {
                timeoutMs: input.timeoutMs,
                deadlineEpochMs: input.deadlineEpochMs,
                completedCommands: results.length,
                totalCommands: input.recipe.commands.length
            }
        },
        nextStatus: 'failed'
    };
}
