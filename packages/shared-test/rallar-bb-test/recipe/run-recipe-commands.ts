import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult
} from '../rallar-black-box-test-contracts.ts';
import { toBoundedDeadlineCommand } from '../runtime/to-runtime-command-values.ts';
import type { RecipeCaptureSequence } from './recipe-capture-sequence.ts';

export interface RecipeCommandsPorts {
    readonly now: () => number;
    readonly runChildCommand: (command: RallarBlackBoxTestCommand) => Promise<RallarBlackBoxTestResult>;
    readonly cancelRequested: () => boolean;
}

export interface RunRecipeCommandsInput {
    readonly recipe: RallarBlackBoxTestRecipe;
    readonly invocation:
        & RecipeCaptureSequence.Selection
        & Readonly<{
            invocationId: string;
            /** Runtime acceptance identity, not a content hash of opaque payloads. */
            recipeBodyId: string;
        }>;
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
            return toCancelledRecipeOutcome(input, results);
        }
        if (deadlineEpochMs !== undefined && ports.now() >= deadlineEpochMs) {
            return toTimedOutRecipeOutcome(input, results);
        }
        const command = deadlineEpochMs === undefined ? child : toBoundedDeadlineCommand(child, deadlineEpochMs);
        const result = await ports.runChildCommand(command);
        results.push(result);
        if (ports.cancelRequested() || result.status === 'cancelled') {
            return toCancelledRecipeOutcome(input, results);
        }
        if (!result.ok && recipe.continueOnFailure !== true) {
            return toFailedRecipeOutcome(input, results, result);
        }
    }
    return {
        status: 'ok',
        value: { recipeId: recipe.recipeId, invocation: input.invocation, results },
        nextStatus: 'completed'
    };
}

function toCancelledRecipeOutcome(
    input: RunRecipeCommandsInput,
    results: readonly RallarBlackBoxTestResult[]
): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'cancelled',
        value: { recipeId: input.recipe.recipeId, invocation: input.invocation, results, cancelled: true },
        nextStatus: 'cancelled'
    };
}

function toFailedRecipeOutcome(
    input: RunRecipeCommandsInput,
    results: readonly RallarBlackBoxTestResult[],
    failed: RallarBlackBoxTestResult
): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'failed',
        value: { recipeId: input.recipe.recipeId, invocation: input.invocation, results },
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
        value: { recipeId: input.recipe.recipeId, invocation: input.invocation, results, timedOut: true },
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
