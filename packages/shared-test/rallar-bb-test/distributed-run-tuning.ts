import {
    DISTRIBUTED_RUN_TUNING_STREAM_THRESHOLD_NAMES,
    type DistributedRunTuningInventory,
    type DistributedRunTuningInventoryLimitation,
    type DistributedRunTuningKnob,
    type DistributedRunTuningKnobConstraint,
    type DistributedRunTuningKnobName
} from './distributed-run-tuning-types.ts';
import type {
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedRunRecipeSelection
} from './distributed-run.ts';
import {
    RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS,
    type RallarBlackBoxTestCommand,
    type RallarBlackBoxTestLoopCommand,
    type RallarBlackBoxTestParallelCommand,
    type RallarBlackBoxTestRtcStreamCommand
} from './rallar-black-box-test-contracts.ts';

type TuningTokens = readonly (string | number)[];

type TunableCommand = RallarBlackBoxTestLoopCommand | RallarBlackBoxTestRtcStreamCommand;

interface TuningCommandContext {
    readonly recipeIndex: number;
    /** Absent before the recipe selection is read, or when the selection names no recipe id. */
    readonly recipeId?: string;
}

interface TuningCommandScope {
    readonly tokens: TuningTokens;
    readonly context: TuningCommandContext;
    readonly depth: number;
}

interface TuningCommandList extends TuningCommandScope {
    /** Absent when a malformed command or parallel group carries no command list. */
    readonly commands: readonly RallarBlackBoxTestCommand[] | undefined;
}

interface TuningCommandTarget {
    readonly tokens: TuningTokens;
    readonly command: TunableCommand;
    readonly context: TuningCommandContext;
}

interface ToCommandSettingKnobInput extends TuningCommandTarget {
    readonly name: Extract<DistributedRunTuningKnobName, 'durationMs' | 'intervalMs' | 'maxInFlight'>;
    /** Absent when the command leaves the setting unset. */
    readonly value: number | undefined;
    readonly constraint: DistributedRunTuningKnobConstraint;
}

interface ToManifestTuningKnobInput {
    readonly name: Extract<DistributedRunTuningKnobName, 'ackTimeoutMs' | 'barrier.timeoutMs'>;
    readonly tokens: TuningTokens;
    /** Absent when the manifest leaves the setting unset. */
    readonly value: number | undefined;
    readonly blocked: boolean;
    /** Absent when nothing qualifies the knob's availability. */
    readonly reason: string | undefined;
}

interface ToCommandTuningKnobInput extends TuningCommandTarget {
    readonly name: DistributedRunTuningKnobName;
    readonly scope: Exclude<DistributedRunTuningKnob['scope'], 'manifest'>;
    /** Absent when the command leaves the setting unset. */
    readonly value: number | undefined;
    readonly constraint: DistributedRunTuningKnobConstraint;
    readonly blocked: boolean;
    /** Absent when nothing qualifies the knob's availability. */
    readonly reason: string | undefined;
}

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
const MAX_EXPANDED_COMMANDS = RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands;

export function computeDistributedRunTuningInventory(
    manifest: RallarBlackBoxDistributedRunManifest
): DistributedRunTuningInventory {
    const barrier = manifest.barrier;
    const walk = new TuningInventoryWalk([
        toManifestTuningKnob({
            name: 'ackTimeoutMs',
            tokens: ['ackTimeoutMs'],
            value: manifest.ackTimeoutMs,
            blocked: false,
            reason: undefined
        }),
        toManifestTuningKnob({
            name: 'barrier.timeoutMs',
            tokens: ['barrier', 'timeoutMs'],
            value: barrier.enabled ? barrier.timeoutMs : undefined,
            blocked: !barrier.enabled,
            reason: barrier.enabled ? undefined : 'The distributed barrier is missing or disabled.'
        })
    ]);
    walk.addRecipes(manifest.recipes);
    return { knobs: walk.knobs, limitations: walk.limitations };
}

export function toDistributedRunTuningJsonPointer(tokens: TuningTokens): string {
    return tokens.map((token) => `/${String(token).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}

/**
 * Tolerates malformed recipe selections and command trees and stops at the shared composite bounds, so an
 * inventory never throws on a manifest that has not passed validation and never walks an unbounded tree.
 */
class TuningInventoryWalk {
    readonly knobs: DistributedRunTuningKnob[];
    readonly limitations: DistributedRunTuningInventoryLimitation[] = [];
    private visitedCommands = 0;
    private visitedStructures = 0;
    private limitReported = false;
    private stopped = false;

    constructor(manifestKnobs: readonly DistributedRunTuningKnob[]) {
        this.knobs = [...manifestKnobs];
    }

    addRecipes(recipes: readonly RallarBlackBoxDistributedRunRecipeSelection[]): void {
        if (!Array.isArray(recipes)) {
            this.reportMalformed('Tuning inventory skipped manifest.recipes because it is not an array.', {
                recipeIndex: 0
            });
            return;
        }
        for (let recipeIndex = 0; recipeIndex < recipes.length && !this.stopped; recipeIndex += 1) {
            if (!this.claimStructure({ recipeIndex })) {
                break;
            }
            this.addRecipe(recipes[recipeIndex], recipeIndex, recipeIndex < recipes.length - 1);
        }
    }

    private addRecipe(
        selection: RallarBlackBoxDistributedRunRecipeSelection | null,
        recipeIndex: number,
        hasLaterRecipes: boolean
    ): void {
        if (!selection || typeof selection !== 'object') {
            this.reportMalformed('Tuning inventory skipped a malformed recipe selection.', { recipeIndex });
            return;
        }
        const recipeId = selection.recipe?.recipeId ?? selection.recipeId;
        if (!selection.recipe) {
            this.limitations.push({
                code: 'reference-only-recipe',
                recipeIndex,
                recipeId,
                message: `Recipe ${
                    recipeId ?? recipeIndex + 1
                } is reference-only; no authoritative inline knobs are available.`
            });
            return;
        }
        const context = { recipeIndex, recipeId };
        this.addCommands({
            commands: selection.recipe.commands,
            tokens: ['recipes', recipeIndex, 'recipe', 'commands'],
            context,
            depth: 0
        });
        if (!this.stopped && this.visitedCommands >= MAX_EXPANDED_COMMANDS && hasLaterRecipes) {
            this.reportCommandLimit(context);
        }
    }

    private addCommands(list: TuningCommandList): void {
        if (this.stopped) {
            return;
        }
        if (list.depth > RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxDepth) {
            this.limitations.push({
                code: 'depth-limit-exceeded',
                message:
                    `Tuning inventory stopped this branch at the shared composite depth ${RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxDepth}.`,
                ...list.context
            });
            return;
        }
        const commands = list.commands;
        if (!Array.isArray(commands)) {
            this.reportMalformed('Tuning inventory skipped a command list that is not an array.', list.context);
            return;
        }
        const nested = { context: list.context, depth: list.depth + 1 };
        for (let index = 0; index < commands.length; index += 1) {
            if (this.visitedCommands >= MAX_EXPANDED_COMMANDS) {
                this.reportCommandLimit(list.context);
                return;
            }
            this.visitedCommands += 1;
            this.addCommand(commands[index], { ...nested, tokens: [...list.tokens, index] });
        }
    }

    private addCommand(command: RallarBlackBoxTestCommand | null | undefined, scope: TuningCommandScope): void {
        if (!command || typeof command !== 'object' || typeof command.kind !== 'string') {
            this.reportMalformed('Tuning inventory skipped a malformed command.', scope.context);
            return;
        }
        if (command.kind === 'loop') {
            const target = { tokens: scope.tokens, command, context: scope.context };
            this.knobs.push(
                toCommandSettingKnob({
                    ...target,
                    name: 'durationMs',
                    value: command.durationMs,
                    constraint: BOUNDED_DURATION
                }),
                toCommandSettingKnob({
                    ...target,
                    name: 'intervalMs',
                    value: command.intervalMs,
                    constraint: NON_NEGATIVE_INTEGER
                })
            );
            this.addCommands({ ...scope, commands: command.commands, tokens: [...scope.tokens, 'commands'] });
        }
        else if (command.kind === 'parallel') {
            this.addParallelGroups(command, scope);
        }
        else if (command.kind === 'recipe.load' || command.kind === 'recipe.run') {
            if (command.recipe) {
                this.addCommands({
                    ...scope,
                    commands: command.recipe.commands,
                    tokens: [...scope.tokens, 'recipe', 'commands']
                });
            }
        }
        else if (command.kind === 'rtc.stream') {
            this.knobs.push(...toStreamCommandTuningKnobs({ tokens: scope.tokens, command, context: scope.context }));
        }
    }

    private addParallelGroups(command: RallarBlackBoxTestParallelCommand, scope: TuningCommandScope): void {
        if (!Array.isArray(command.groups)) {
            this.reportMalformed('Tuning inventory skipped parallel.groups because it is not an array.', scope.context);
            return;
        }
        for (let groupIndex = 0; groupIndex < command.groups.length && !this.stopped; groupIndex += 1) {
            if (this.visitedCommands >= MAX_EXPANDED_COMMANDS || !this.claimStructure(scope.context)) {
                this.reportCommandLimit(scope.context);
                break;
            }
            const group: { readonly commands?: readonly RallarBlackBoxTestCommand[]; } | null =
                command.groups[groupIndex];
            this.addCommands({
                ...scope,
                commands: group?.commands,
                tokens: [...scope.tokens, 'groups', groupIndex, 'commands']
            });
        }
    }

    private claimStructure(context: TuningCommandContext): boolean {
        if (this.visitedStructures >= MAX_EXPANDED_COMMANDS) {
            this.reportCommandLimit(context);
            return false;
        }
        this.visitedStructures += 1;
        return true;
    }

    private reportCommandLimit(context: TuningCommandContext): void {
        this.stopped = true;
        if (this.limitReported) {
            return;
        }
        this.limitReported = true;
        this.limitations.push({
            code: 'command-limit-exceeded',
            message: `Tuning inventory stopped at the shared ${MAX_EXPANDED_COMMANDS}-command limit.`,
            ...context
        });
    }

    private reportMalformed(message: string, context: TuningCommandContext): void {
        this.limitations.push({ code: 'malformed-command', message, ...context });
    }
}

function toStreamCommandTuningKnobs(
    target: TuningCommandTarget & Readonly<{ command: RallarBlackBoxTestRtcStreamCommand; }>
): readonly DistributedRunTuningKnob[] {
    const { command } = target;
    const rateShadowed = command.intervalMs !== undefined;
    return [
        toCommandSettingKnob({
            ...target,
            name: 'durationMs',
            value: command.durationMs,
            constraint: BOUNDED_DURATION
        }),
        toCommandSettingKnob({
            ...target,
            name: 'intervalMs',
            value: command.intervalMs,
            constraint: POSITIVE_INTEGER
        }),
        toCommandTuningKnob({
            ...target,
            name: 'rateHz',
            scope: 'command',
            tokens: [...target.tokens, 'rateHz'],
            value: command.rateHz,
            constraint: POSITIVE_RATE,
            blocked: rateShadowed,
            reason: rateShadowed ? 'intervalMs takes precedence over rateHz for RTC stream scheduling.' : undefined
        }),
        toCommandSettingKnob({
            ...target,
            name: 'maxInFlight',
            value: command.maxInFlight,
            constraint: POSITIVE_INTEGER
        }),
        ...DISTRIBUTED_RUN_TUNING_STREAM_THRESHOLD_NAMES.map((threshold) =>
            toCommandTuningKnob({
                ...target,
                name: `thresholds.${threshold}`,
                scope: 'stream-threshold',
                tokens: [...target.tokens, 'thresholds', threshold],
                value: command.thresholds?.[threshold],
                constraint: threshold === 'minSendSuccessRatio' ? RATIO : NON_NEGATIVE_NUMBER,
                blocked: false,
                reason: command.thresholds === undefined
                    ? 'The optional thresholds object is not configured.'
                    : undefined
            })
        )
    ];
}

function toCommandSettingKnob(input: ToCommandSettingKnobInput): DistributedRunTuningKnob {
    return toCommandTuningKnob({
        ...input,
        scope: 'command',
        tokens: [...input.tokens, input.name],
        blocked: false,
        reason: undefined
    });
}

function toManifestTuningKnob(input: ToManifestTuningKnobInput): DistributedRunTuningKnob {
    return {
        name: input.name,
        pointer: toDistributedRunTuningJsonPointer(input.tokens),
        scope: 'manifest',
        currentValue: input.value,
        availability: toKnobAvailability(input.blocked, input.value),
        effective: !input.blocked,
        constraint: POSITIVE_INTEGER,
        reason: input.reason
    };
}

function toCommandTuningKnob(input: ToCommandTuningKnobInput): DistributedRunTuningKnob {
    return {
        name: input.name,
        pointer: toDistributedRunTuningJsonPointer(input.tokens),
        scope: input.scope,
        currentValue: input.value,
        availability: toKnobAvailability(input.blocked, input.value),
        effective: !input.blocked,
        constraint: input.constraint,
        recipeIndex: input.context.recipeIndex,
        recipeId: input.context.recipeId,
        commandId: input.command.commandId,
        commandKind: input.command.kind,
        reason: input.reason
    };
}

function toKnobAvailability(
    blocked: boolean,
    value: number | undefined
): DistributedRunTuningKnob['availability'] {
    return blocked ? 'blocked' : value === undefined ? 'unset' : 'configured';
}
