import {
    DISTRIBUTED_RUN_TUNING_STREAM_THRESHOLD_NAMES,
    type DistributedRunTuningInventory,
    type DistributedRunTuningInventoryLimitation,
    type DistributedRunTuningKnob,
    type DistributedRunTuningKnobConstraint,
    type DistributedRunTuningKnobName
} from './distributed-run-tuning-types.ts';
import type { RallarBlackBoxDistributedRunManifest } from './distributed-run.ts';
import { RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS, type RallarBlackBoxTestCommand } from './types.ts';
export * from './distributed-run-tuning-types.ts';

type CommandContext = Readonly<{
    recipeIndex: number;
    recipeId?: string;
}>;

const POSITIVE_INTEGER: DistributedRunTuningKnobConstraint = {
    type: 'integer',
    minimum: 1
};
const NON_NEGATIVE_INTEGER: DistributedRunTuningKnobConstraint = {
    type: 'integer',
    minimum: 0
};
const POSITIVE_RATE: DistributedRunTuningKnobConstraint = {
    type: 'number',
    exclusiveMinimum: 0
};
const NON_NEGATIVE_NUMBER: DistributedRunTuningKnobConstraint = {
    type: 'number',
    minimum: 0
};
const RATIO: DistributedRunTuningKnobConstraint = {
    type: 'number',
    minimum: 0,
    maximum: 1
};
const BOUNDED_DURATION: DistributedRunTuningKnobConstraint = {
    type: 'integer',
    minimum: 1,
    maximum: RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopDurationMs
};

export function inventoryDistributedRunTuningKnobs(
    manifest: RallarBlackBoxDistributedRunManifest
): DistributedRunTuningInventory {
    const knobs: DistributedRunTuningKnob[] = [
        numericKnob({
            name: 'ackTimeoutMs',
            tokens: ['ackTimeoutMs'],
            scope: 'manifest',
            value: manifest.ackTimeoutMs,
            constraint: POSITIVE_INTEGER
        }),
        barrierTimeoutKnob(manifest)
    ];
    const limitations: DistributedRunTuningInventoryLimitation[] = [];
    let visitedCommands = 0;
    let visitedStructures = 0;
    let limitReported = false;
    let stopped = false;

    const limit = (context: CommandContext): void => {
        stopped = true;
        if (limitReported) {
            return;
        }
        limitReported = true;
        limitations.push({
            code: 'command-limit-exceeded',
            message:
                `Tuning inventory stopped at the shared ${RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands}-command limit.`,
            ...context
        });
    };

    const malformed = (message: string, context: CommandContext): void => {
        limitations.push({ code: 'malformed-command', message, ...context });
    };

    const claimStructure = (context: CommandContext): boolean => {
        if (visitedStructures >= RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands) {
            limit(context);
            return false;
        }
        visitedStructures += 1;
        return true;
    };

    const walk = (
        commands: unknown,
        parentTokens: readonly (string | number)[],
        context: CommandContext,
        depth = 0
    ): void => {
        if (stopped) {
            return;
        }
        if (depth > RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxDepth) {
            limitations.push({
                code: 'depth-limit-exceeded',
                message:
                    `Tuning inventory stopped this branch at the shared composite depth ${RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxDepth}.`,
                ...context
            });
            return;
        }
        if (!Array.isArray(commands)) {
            malformed('Tuning inventory skipped a command list that is not an array.', context);
            return;
        }
        for (let index = 0; index < commands.length; index += 1) {
            if (visitedCommands >= RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands) {
                limit(context);
                return;
            }
            visitedCommands += 1;
            const command = commands[index] as RallarBlackBoxTestCommand | null;
            if (!command || typeof command !== 'object' || typeof command.kind !== 'string') {
                malformed('Tuning inventory skipped a malformed command.', context);
                continue;
            }
            const tokens = [...parentTokens, index];
            if (command.kind === 'loop') {
                knobs.push(
                    commandKnob('durationMs', command.durationMs, BOUNDED_DURATION, tokens, command, context),
                    commandKnob('intervalMs', command.intervalMs, NON_NEGATIVE_INTEGER, tokens, command, context)
                );
                walk(command.commands, [...tokens, 'commands'], context, depth + 1);
            }
            else if (command.kind === 'parallel') {
                if (!Array.isArray(command.groups)) {
                    malformed('Tuning inventory skipped parallel.groups because it is not an array.', context);
                    continue;
                }
                for (let groupIndex = 0; groupIndex < command.groups.length && !stopped; groupIndex += 1) {
                    if (
                        visitedCommands >= RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands ||
                        !claimStructure(context)
                    ) {
                        limit(context);
                        break;
                    }
                    const group = command.groups[groupIndex] as { commands?: unknown; } | null;
                    walk(group?.commands, [...tokens, 'groups', groupIndex, 'commands'], context, depth + 1);
                }
            }
            else if (command.kind === 'recipe.load' || command.kind === 'recipe.run') {
                if (command.recipe) {
                    walk(command.recipe.commands, [...tokens, 'recipe', 'commands'], context, depth + 1);
                }
            }
            else if (command.kind === 'rtc.stream') {
                knobs.push(...streamCommandKnobs(command, tokens, context));
            }
        }
    };

    if (!Array.isArray(manifest.recipes)) {
        malformed('Tuning inventory skipped manifest.recipes because it is not an array.', { recipeIndex: 0 });
        return { knobs, limitations };
    }
    for (let recipeIndex = 0; recipeIndex < manifest.recipes.length && !stopped; recipeIndex += 1) {
        const baseContext = { recipeIndex };
        if (!claimStructure(baseContext)) {
            break;
        }
        const selection = manifest.recipes[recipeIndex] as typeof manifest.recipes[number] | null;
        if (!selection || typeof selection !== 'object') {
            malformed('Tuning inventory skipped a malformed recipe selection.', baseContext);
            continue;
        }
        const recipeId = selection.recipe?.recipeId ?? selection.recipeId;
        if (!selection.recipe) {
            limitations.push({
                code: 'reference-only-recipe',
                recipeIndex,
                recipeId,
                message: `Recipe ${
                    recipeId ?? recipeIndex + 1
                } is reference-only; no authoritative inline knobs are available.`
            });
            continue;
        }
        walk(
            selection.recipe.commands,
            ['recipes', recipeIndex, 'recipe', 'commands'],
            { recipeIndex, recipeId }
        );
        if (
            !stopped &&
            visitedCommands >= RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands &&
            recipeIndex < manifest.recipes.length - 1
        ) {
            limit({ recipeIndex, recipeId });
        }
    }
    return { knobs, limitations };
}

function streamCommandKnobs(
    command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.stream'; }>,
    tokens: readonly (string | number)[],
    context: CommandContext
): readonly DistributedRunTuningKnob[] {
    const rateShadowed = command.intervalMs !== undefined;
    const rows = [
        commandKnob('durationMs', command.durationMs, BOUNDED_DURATION, tokens, command, context),
        commandKnob('intervalMs', command.intervalMs, POSITIVE_INTEGER, tokens, command, context),
        commandKnob('rateHz', command.rateHz, POSITIVE_RATE, tokens, command, context, {
            blocked: rateShadowed,
            reason: rateShadowed
                ? 'intervalMs takes precedence over rateHz for RTC stream scheduling.'
                : undefined
        }),
        commandKnob('maxInFlight', command.maxInFlight, POSITIVE_INTEGER, tokens, command, context)
    ];
    for (const threshold of DISTRIBUTED_RUN_TUNING_STREAM_THRESHOLD_NAMES) {
        rows.push(numericKnob({
            name: `thresholds.${threshold}`,
            tokens: [...tokens, 'thresholds', threshold],
            scope: 'stream-threshold',
            value: command.thresholds?.[threshold],
            constraint: threshold === 'minSendSuccessRatio' ? RATIO : NON_NEGATIVE_NUMBER,
            command,
            context,
            reason: command.thresholds === undefined
                ? 'The optional thresholds object is not configured.'
                : undefined
        }));
    }
    return rows;
}

function commandKnob(
    name: Extract<DistributedRunTuningKnobName, 'durationMs' | 'intervalMs' | 'rateHz' | 'maxInFlight'>,
    value: number | undefined,
    constraint: DistributedRunTuningKnobConstraint,
    tokens: readonly (string | number)[],
    command: Extract<RallarBlackBoxTestCommand, { kind: 'loop' | 'rtc.stream'; }>,
    context: CommandContext,
    options: Readonly<{ blocked?: boolean; reason?: string; }> = {}
): DistributedRunTuningKnob {
    return numericKnob({
        name,
        tokens: [...tokens, name],
        scope: 'command',
        value,
        constraint,
        command,
        context,
        blocked: options.blocked,
        reason: options.reason
    });
}

function barrierTimeoutKnob(
    manifest: RallarBlackBoxDistributedRunManifest
): DistributedRunTuningKnob {
    const enabled = manifest.barrier?.enabled === true;
    return numericKnob({
        name: 'barrier.timeoutMs',
        tokens: ['barrier', 'timeoutMs'],
        scope: 'manifest',
        value: manifest.barrier?.timeoutMs,
        constraint: POSITIVE_INTEGER,
        blocked: !enabled,
        reason: enabled ? undefined : 'The distributed barrier is missing or disabled.'
    });
}

function numericKnob(
    input: Readonly<{
        name: DistributedRunTuningKnobName;
        tokens: readonly (string | number)[];
        scope: DistributedRunTuningKnob['scope'];
        value?: number;
        constraint: DistributedRunTuningKnobConstraint;
        command?: Extract<RallarBlackBoxTestCommand, { kind: 'loop' | 'rtc.stream'; }>;
        context?: CommandContext;
        blocked?: boolean;
        reason?: string;
    }>
): DistributedRunTuningKnob {
    return {
        name: input.name,
        pointer: distributedRunTuningJsonPointer(input.tokens),
        scope: input.scope,
        currentValue: input.value,
        availability: input.blocked
            ? 'blocked'
            : input.value === undefined
            ? 'unset'
            : 'configured',
        effective: input.blocked !== true,
        constraint: input.constraint,
        recipeIndex: input.context?.recipeIndex,
        recipeId: input.context?.recipeId,
        commandId: input.command?.commandId,
        commandKind: input.command?.kind,
        reason: input.reason
    };
}

export function distributedRunTuningJsonPointer(
    tokens: readonly (string | number)[]
): string {
    return tokens.map((token) => `/${String(token).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}
