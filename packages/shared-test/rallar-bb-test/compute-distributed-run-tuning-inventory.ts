import {
    DISTRIBUTED_RUN_TUNING_STREAM_THRESHOLD_NAMES,
    type DistributedRunCommandTuningKnob,
    type DistributedRunCommandTuningKnobName,
    type DistributedRunManifestTuningKnob,
    type DistributedRunManifestTuningKnobName,
    type DistributedRunTuningInventory,
    type DistributedRunTuningInventoryLimitation,
    type DistributedRunTuningKnob,
    type DistributedRunTuningKnobConstraint
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

type TuningLimitationPosition = Pick<DistributedRunTuningInventoryLimitation, 'recipeIndex' | 'recipeId'>;

interface TuningCommandContext {
    readonly recipeIndex: number;
    readonly recipeId: string;
}

interface TuningCommandScope {
    readonly tokens: TuningTokens;
    readonly context: TuningCommandContext;
    readonly depth: number;
}

interface TuningCommandList extends TuningCommandScope {
    readonly commands: readonly RallarBlackBoxTestCommand[];
}

interface TuningCommandTarget {
    readonly tokens: TuningTokens;
    readonly command: TunableCommand;
    readonly context: TuningCommandContext;
}

interface ToCommandSettingKnobInput extends TuningCommandTarget {
    readonly name: Extract<DistributedRunCommandTuningKnobName, 'durationMs' | 'intervalMs' | 'maxInFlight'>;
    /** Absent when the command leaves the setting unset. */
    readonly value: number | undefined;
    readonly constraint: DistributedRunTuningKnobConstraint;
}

interface ToManifestTuningKnobInput {
    readonly name: DistributedRunManifestTuningKnobName;
    readonly tokens: TuningTokens;
    /** Absent when the manifest leaves the setting unset. */
    readonly value: number | undefined;
    readonly blocked: boolean;
    /** Absent when nothing qualifies the knob's availability. */
    readonly reason: string | undefined;
}

interface ToCommandTuningKnobInput extends TuningCommandTarget {
    readonly name: DistributedRunCommandTuningKnobName;
    readonly scope: DistributedRunCommandTuningKnob['scope'];
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
            reason: barrier.enabled ? undefined : 'The distributed barrier is disabled.'
        })
    ]);
    walk.addRecipes(manifest.recipes);
    return { knobs: walk.knobs, limitations: walk.limitations };
}

/** Walks a decoded manifest's recipe and command trees and stops at the shared composite depth and command bounds. */
class TuningInventoryWalk {
    readonly knobs: DistributedRunTuningKnob[];
    readonly limitations: DistributedRunTuningInventoryLimitation[] = [];
    private visitedCommands = 0;
    private visitedStructures = 0;
    private commandLimitReached = false;

    constructor(manifestKnobs: readonly DistributedRunManifestTuningKnob[]) {
        this.knobs = [...manifestKnobs];
    }

    addRecipes(recipes: readonly RallarBlackBoxDistributedRunRecipeSelection[]): void {
        for (let recipeIndex = 0; recipeIndex < recipes.length && !this.commandLimitReached; recipeIndex += 1) {
            if (!this.hasStructureBudget()) {
                this.setCommandLimitReached({ recipeIndex });
                break;
            }
            this.visitedStructures += 1;
            this.addRecipe(recipes[recipeIndex], recipeIndex, recipeIndex < recipes.length - 1);
        }
    }

    private addRecipe(
        selection: RallarBlackBoxDistributedRunRecipeSelection,
        recipeIndex: number,
        hasLaterRecipes: boolean
    ): void {
        const recipeId = selection.recipe?.recipeId ?? selection.recipeId;
        if (!selection.recipe) {
            this.limitations.push({
                code: 'reference-only-recipe',
                recipeIndex,
                recipeId,
                message: `Recipe ${recipeId} is reference-only; no authoritative inline knobs are available.`
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
        if (!this.hasCommandBudget() && hasLaterRecipes) {
            this.setCommandLimitReached(context);
        }
    }

    private addCommands(list: TuningCommandList): void {
        if (this.commandLimitReached) {
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
        const nested = { context: list.context, depth: list.depth + 1 };
        for (let index = 0; index < list.commands.length; index += 1) {
            if (!this.hasCommandBudget()) {
                this.setCommandLimitReached(list.context);
                return;
            }
            this.visitedCommands += 1;
            this.addCommand(list.commands[index], { ...nested, tokens: [...list.tokens, index] });
        }
    }

    private addCommand(command: RallarBlackBoxTestCommand, scope: TuningCommandScope): void {
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
        else if ((command.kind === 'recipe.load' || command.kind === 'recipe.run') && command.recipe) {
            this.addCommands({
                ...scope,
                commands: command.recipe.commands,
                tokens: [...scope.tokens, 'recipe', 'commands']
            });
        }
        else if (command.kind === 'rtc.stream') {
            this.knobs.push(...toStreamCommandTuningKnobs({ tokens: scope.tokens, command, context: scope.context }));
        }
    }

    private addParallelGroups(command: RallarBlackBoxTestParallelCommand, scope: TuningCommandScope): void {
        for (let groupIndex = 0; groupIndex < command.groups.length && !this.commandLimitReached; groupIndex += 1) {
            if (!this.hasCommandBudget() || !this.hasStructureBudget()) {
                this.setCommandLimitReached(scope.context);
                break;
            }
            this.visitedStructures += 1;
            this.addCommands({
                ...scope,
                commands: command.groups[groupIndex].commands,
                tokens: [...scope.tokens, 'groups', groupIndex, 'commands']
            });
        }
    }

    private hasCommandBudget(): boolean {
        return this.visitedCommands < MAX_EXPANDED_COMMANDS;
    }

    private hasStructureBudget(): boolean {
        return this.visitedStructures < MAX_EXPANDED_COMMANDS;
    }

    private setCommandLimitReached(position: TuningLimitationPosition): void {
        if (this.commandLimitReached) {
            return;
        }
        this.commandLimitReached = true;
        this.limitations.push({
            code: 'command-limit-exceeded',
            message: `Tuning inventory stopped at the shared ${MAX_EXPANDED_COMMANDS}-command limit.`,
            ...position
        });
    }
}

function toStreamCommandTuningKnobs(
    target: TuningCommandTarget & Readonly<{ command: RallarBlackBoxTestRtcStreamCommand; }>
): readonly DistributedRunCommandTuningKnob[] {
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

function toCommandSettingKnob(input: ToCommandSettingKnobInput): DistributedRunCommandTuningKnob {
    return toCommandTuningKnob({
        ...input,
        scope: 'command',
        tokens: [...input.tokens, input.name],
        blocked: false,
        reason: undefined
    });
}

function toManifestTuningKnob(input: ToManifestTuningKnobInput): DistributedRunManifestTuningKnob {
    return {
        name: input.name,
        pointer: toTuningJsonPointer(input.tokens),
        scope: 'manifest',
        currentValue: input.value,
        availability: toKnobAvailability(input.blocked, input.value),
        effective: !input.blocked,
        constraint: POSITIVE_INTEGER,
        reason: input.reason
    };
}

function toCommandTuningKnob(input: ToCommandTuningKnobInput): DistributedRunCommandTuningKnob {
    return {
        name: input.name,
        pointer: toTuningJsonPointer(input.tokens),
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

function toTuningJsonPointer(tokens: TuningTokens): string {
    return tokens.map((token) => `/${String(token).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}
