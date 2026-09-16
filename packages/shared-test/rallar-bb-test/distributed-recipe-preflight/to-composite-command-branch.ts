import {
    RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS,
    type RallarBlackBoxTestCommand
} from '../rallar-black-box-test-contracts.ts';
import { decodePositiveInteger } from '../runtime/decode-runtime-result-values.ts';
import { computeLoopIterationEstimate } from './compute-loop-iteration-estimate.ts';
import { computeEffectiveFrameCount } from './distributed-recipe-command-preview.ts';
import type {
    DistributedRecipeCommandAnalysis,
    DistributedRecipeCommandBranch
} from './distributed-recipe-preflight-contracts.ts';

/**
 * The walker binds the child depth before it calls a branch, so branch modules
 * never repeat the composite depth policy.
 */
export type ToChildCommandAnalysis = (
    command: RallarBlackBoxTestCommand,
    path: string
) => DistributedRecipeCommandAnalysis;

export function toLoopCommandBranch(
    command: Extract<RallarBlackBoxTestCommand, { kind: 'loop'; }>,
    path: string,
    toChildCommandAnalysis: ToChildCommandAnalysis
): DistributedRecipeCommandBranch {
    const childAnalyses = command.commands.map((child, index) =>
        toChildCommandAnalysis(child, `${path}.commands[${index}]`)
    );
    const estimate = computeLoopIterationEstimate(command);
    const childEffectiveCommandCount = childAnalyses.reduce(
        (sum, analysis) => sum + analysis.effectiveCommandCount,
        0
    );
    const effectiveCommandCount = childEffectiveCommandCount * estimate.estimatedIterations;
    return {
        effectiveCommandCount,
        childAnalyses,
        summary: `loop x${estimate.estimatedIterations}`,
        details: [
            `${command.commands.length} child command${command.commands.length === 1 ? '' : 's'}`,
            `${effectiveCommandCount} effective operation${effectiveCommandCount === 1 ? '' : 's'}`,
            ...(estimate.intervalMs === undefined ? [] : [`interval ${estimate.intervalMs} ms`]),
            ...(estimate.durationMs === undefined ? [] : [`duration ${estimate.durationMs} ms`])
        ],
        warnings: estimate.warnings.map((warning) => `${path}: ${warning}`),
        errors: [
            ...(command.commands.length === 0 ? [`${path} has no loop child commands.`] : []),
            ...estimate.limitErrors.map((error) => `${path}: ${error}`)
        ],
        loops: [{
            path,
            commandId: command.commandId,
            estimatedIterations: estimate.estimatedIterations,
            childCommandCount: command.commands.length,
            effectiveCommandCount,
            count: decodePositiveInteger(command.count),
            durationMs: decodePositiveInteger(command.durationMs),
            intervalMs: estimate.intervalMs,
            maxCommands: decodePositiveInteger(command.maxCommands),
            frameCount: computeEffectiveFrameCount(command)
        }],
        parallelGroups: [],
        waits: [],
        asserts: []
    };
}

export function toParallelCommandBranch(
    command: Extract<RallarBlackBoxTestCommand, { kind: 'parallel'; }>,
    path: string,
    toChildCommandAnalysis: ToChildCommandAnalysis
): DistributedRecipeCommandBranch {
    const childAnalyses = command.groups.flatMap((group, groupIndex) =>
        group.commands.map((child, commandIndex) =>
            toChildCommandAnalysis(child, `${path}.groups[${groupIndex}].commands[${commandIndex}]`)
        )
    );
    const effectiveCommandCount = childAnalyses.reduce(
        (sum, analysis) => sum + analysis.effectiveCommandCount,
        0
    );
    const maxConcurrency = decodePositiveInteger(command.maxConcurrency) ?? command.groups.length;
    return {
        effectiveCommandCount,
        childAnalyses,
        summary: `parallel ${command.groups.length} group${command.groups.length === 1 ? '' : 's'}`,
        details: [
            `max concurrency ${maxConcurrency}`,
            `${effectiveCommandCount} effective operation${effectiveCommandCount === 1 ? '' : 's'}`
        ],
        warnings: [],
        errors: [
            ...(command.groups.length === 0 ? [`${path} has no parallel groups.`] : []),
            ...(maxConcurrency > RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxParallelConcurrency
                ? [
                    `${path}: parallel maxConcurrency ${maxConcurrency} exceeds ` +
                    `${RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxParallelConcurrency}.`
                ]
                : [])
        ],
        loops: [],
        parallelGroups: [{
            path,
            commandId: command.commandId,
            groupCount: command.groups.length,
            maxConcurrency,
            effectiveCommandCount,
            groups: command.groups.map((group, index) => group.label ?? group.groupId ?? `group ${index + 1}`)
        }],
        waits: [],
        asserts: []
    };
}

export function toNestedRecipeCommandBranch(
    command: Extract<RallarBlackBoxTestCommand, { kind: 'recipe.load' | 'recipe.run'; }>,
    path: string,
    toChildCommandAnalysis: ToChildCommandAnalysis
): DistributedRecipeCommandBranch {
    const nestedRecipe = command.recipe;
    if (!nestedRecipe) {
        return {
            ...createEmptyCommandBranch(),
            summary: 'run loaded recipe'
        };
    }

    const childAnalyses = nestedRecipe.commands.map((child, index) =>
        toChildCommandAnalysis(child, `${path}.recipe.commands[${index}]`)
    );
    const runsNestedCommands = command.kind === 'recipe.run';
    return {
        ...createEmptyCommandBranch(),
        effectiveCommandCount: runsNestedCommands
            ? childAnalyses.reduce((sum, analysis) => sum + analysis.effectiveCommandCount, 0)
            : 1,
        childAnalyses,
        summary: `${runsNestedCommands ? 'runs' : 'loads'} ${nestedRecipe.commands.length} recipe command${
            nestedRecipe.commands.length === 1 ? '' : 's'
        }`,
        details: [nestedRecipe.recipeId]
    };
}

function createEmptyCommandBranch(): DistributedRecipeCommandBranch {
    return {
        effectiveCommandCount: 1,
        childAnalyses: [],
        details: [],
        warnings: [],
        errors: [],
        loops: [],
        parallelGroups: [],
        waits: [],
        asserts: []
    };
}
