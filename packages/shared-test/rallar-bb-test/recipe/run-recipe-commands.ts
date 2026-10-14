import { Either } from '@shared/resilience/Either.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult
} from '../rallar-black-box-test-contracts.ts';
import type { RallarBlackBoxEventHistoryPolicy } from '../runtime/event-history.ts';
import { toBoundedDeadlineCommand } from '../runtime/to-runtime-command-values.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import type { RecipeCaptureSequence } from './recipe-capture-sequence.ts';

/** A range of the accepted outer intent, not a replacement authored recipe. */
export interface RecipeExecutionSegment {
    readonly start: number;
    readonly end: number;
    readonly first: boolean;
}

export function decodeRecipeExecutionSegment(value: unknown): Either<string, RecipeExecutionSegment> {
    if (
        !isJsonRecordValue(value) || typeof value.start !== 'number' || !Number.isSafeInteger(value.start) ||
        value.start < 0 ||
        typeof value.end !== 'number' || !Number.isSafeInteger(value.end) || value.end < value.start ||
        typeof value.first !== 'boolean' ||
        (value.first && value.start !== 0) || (!value.first && value.start === value.end) ||
        Object.keys(value).some((key) => key !== 'start' && key !== 'end' && key !== 'first')
    ) {
        return Either.ofLeft('Recipe execution requires a valid finite segment of its accepted outer intent.');
    }
    return Either.ofRight(Object.freeze({ start: value.start, end: value.end, first: value.first }));
}

export interface RecipeCommandsPorts {
    readonly now: () => number;
    readonly runChildCommand: (command: RallarBlackBoxTestCommand) => Promise<RallarBlackBoxTestResult>;
    readonly cancelRequested: () => boolean;
}

export interface RunRecipeCommandsInput {
    readonly recipe: RallarBlackBoxTestRecipe;
    readonly segment: RecipeExecutionSegment | undefined;
    readonly invocation:
        & RecipeCaptureSequence.Selection
        & Readonly<{
            eventHistory: RallarBlackBoxEventHistoryPolicy;
            invocationId: string;
            /** Runtime acceptance identity, not a content hash of opaque payloads. */
            recipeBodyId: string;
            segment?: RecipeExecutionSegment;
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
    const commands = input.segment === undefined
        ? recipe.commands
        : recipe.commands.slice(input.segment.start, input.segment.end);
    for (const child of commands) {
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
                totalCommands: input.segment === undefined
                    ? input.recipe.commands.length
                    : input.segment.end - input.segment.start
            }
        },
        nextStatus: 'failed'
    };
}
