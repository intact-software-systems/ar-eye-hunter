import {
    toRallarBlackBoxLoopChildResultPath,
    toRallarBlackBoxLoopChildSourceRecipePath,
    toRallarBlackBoxParallelChildResultPath,
    toRallarBlackBoxParallelChildSourceRecipePath
} from '../composite-result-paths.ts';
import type { RallarBlackBoxCompositeResultFlatEntry } from '../composite-results.ts';
import type { ControlCommandEnvelope, ControlResultEnvelope } from '../control-protocol.ts';
import type { ControlQueuedCommandSnapshot } from '../control-snapshots.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRecipeRunCommand
} from '../rallar-black-box-test-contracts.ts';
import { decodeRecipeExecutionSegment } from '../recipe/run-recipe-commands.ts';
import { decodeRecord, decodeText } from '../runtime/decode-runtime-result-values.ts';

export interface ControlCommandEvidenceInput {
    readonly command: ControlCommandEnvelope | undefined;
    readonly envelope: ControlResultEnvelope;
    readonly commands: readonly ControlQueuedCommandSnapshot[];
    readonly results: readonly ControlResultEnvelope[];
}

export interface ControlCommandAttribution {
    readonly commands: ReadonlyMap<string, RallarBlackBoxTestCommand>;
    readonly recipes: ReadonlyMap<string, RallarBlackBoxTestRecipe>;
}

export interface AcknowledgedControlRecipeInput {
    readonly command: ControlCommandEnvelope;
    readonly agentId: string;
    readonly commands: readonly ControlQueuedCommandSnapshot[];
    readonly results: readonly ControlResultEnvelope[];
}

export interface AcknowledgedControlRecipe {
    readonly recipe: RallarBlackBoxTestRecipe;
    readonly recipeBodyId: string;
}

/** The finite queued load and its successful acknowledgment own this token, never a sender's claimed invocation. */
export function resolveAcknowledgedControlRecipe(
    input: AcknowledgedControlRecipeInput
): AcknowledgedControlRecipe | undefined {
    const rootIndex = input.commands.findIndex((queued) => queued.envelope.commandId === input.command.commandId);
    if (rootIndex < 0) {
        return undefined;
    }
    const load = input.commands.slice(0, rootIndex).filter((queued) =>
        queued.envelope.agentId === input.agentId && queued.envelope.command.kind === 'recipe.load' &&
        queued.completedAtEpochMs !== undefined
    ).at(-1);
    const result = input.results.find((envelope) => envelope.commandId === load?.envelope.commandId);
    if (
        load?.envelope.command.kind !== 'recipe.load' || result?.ok !== true || result.agentId !== input.agentId ||
        result.runId !== input.command.runId
    ) {
        return undefined;
    }
    const recipeBodyId = decodeText(decodeRecord(result.result?.value).recipeBodyId);
    return recipeBodyId === undefined ? undefined : { recipe: load.envelope.command.recipe, recipeBodyId };
}

/** An existing completed load supplies authored commands; this does not certify a content hash or fresh scope. */
export function resolveControlExecutionCommand(
    input: ControlCommandEvidenceInput
): RallarBlackBoxTestCommand | undefined {
    const queued = input.command;
    const command = queued?.command;
    if (queued === undefined || command === undefined) {
        return undefined;
    }
    if (command.kind !== 'recipe.run') {
        return command;
    }
    const accepted = command.recipe === undefined
        ? resolveAcknowledgedControlRecipe({
            command: queued,
            agentId: input.envelope.agentId,
            commands: input.commands,
            results: input.results
        })
        : undefined;
    const known = accepted === undefined ? command : {
        ...command,
        recipe: accepted.recipe,
        expectedRecipeBodyId: command.expectedRecipeBodyId ?? accepted.recipeBodyId
    };
    if (queued.recipeExecution === undefined) {
        return known;
    }
    const segment = decodeRecipeExecutionSegment(queued.recipeExecution.segment).right;
    const actual =
        decodeRecipeExecutionSegment(decodeRecord(decodeRecord(input.envelope.result?.value).invocation).segment).right;
    if (
        segment === undefined || known.recipe === undefined || segment.end > known.recipe.commands.length ||
        actual === undefined ||
        actual.start !== segment.start || actual.end !== segment.end || actual.first !== segment.first
    ) {
        return undefined;
    }
    // The original queued intent owns provenance; application requirements belong only to its actual executed range.
    return { ...known, recipe: { ...known.recipe, commands: known.recipe.commands.slice(segment.start, segment.end) } };
}

/** Indexes only the owned recipe/loop/parallel result shapes already decoded by the composite owner. */
export function toControlCommandAttribution(
    root: RallarBlackBoxTestCommand,
    entries: readonly RallarBlackBoxCompositeResultFlatEntry[],
    references: ReadonlyMap<RallarBlackBoxTestRecipeRunCommand, ReadonlySet<RallarBlackBoxTestRecipe>>
): ControlCommandAttribution {
    const commands = new Map<string, RallarBlackBoxTestCommand>();
    const recipes = new Map<string, RallarBlackBoxTestRecipe>();
    for (const entry of entries) {
        const position = entry.position;
        if (position.kind === 'root') {
            commands.set(entry.path, root);
            if (root.kind === 'recipe.run' && root.recipe !== undefined) {
                recipes.set(entry.path, root.recipe);
            }
            continue;
        }
        const parent = commands.get(position.parentPath);
        const children = parent?.kind === 'recipe.run'
            ? recipes.get(position.parentPath)?.commands
            : parent?.kind === 'loop'
            ? parent.commands
            : parent?.kind === 'parallel' && position.kind === 'parallel-child'
            ? parent.groups[position.groupIndex]?.commands
            : undefined;
        const child = children?.[position.commandIndex];
        if (child && entry.kind === child.kind) {
            commands.set(entry.path, child);
            if (child.kind === 'recipe.run') {
                const bodies = references.get(child);
                const recipe = child.recipe ?? (bodies?.size === 1 ? [...bodies][0] : undefined);
                if (recipe !== undefined) {
                    recipes.set(entry.path, recipe);
                }
            }
        }
    }
    return { commands, recipes };
}

export function isCompositeAttributionConsistent(
    entry: RallarBlackBoxCompositeResultFlatEntry,
    entries: readonly RallarBlackBoxCompositeResultFlatEntry[],
    commands: ReadonlyMap<string, RallarBlackBoxTestCommand>
): boolean {
    const position = entry.position;
    if (position.kind === 'root' || position.kind === 'recipe-child') {
        return true;
    }
    const parent = entries.find((candidate) => candidate.path === position.parentPath);
    if (!parent || position.parentCommandId !== parent.commandId) {
        return false;
    }
    if (position.kind === 'loop-child') {
        return entry.path ===
                toRallarBlackBoxLoopChildResultPath(parent.path, position.iteration, position.commandIndex) &&
            entry.sourceRecipePath ===
                toRallarBlackBoxLoopChildSourceRecipePath(parent.sourceRecipePath, position.commandIndex);
    }
    const parentCommand = commands.get(parent.path);
    const group = parentCommand?.kind === 'parallel' ? parentCommand.groups[position.groupIndex] : undefined;
    return group !== undefined && (group.groupId === undefined || group.groupId === position.groupId) &&
        entry.path === toRallarBlackBoxParallelChildResultPath({
                parentPath: parent.path,
                groupId: position.groupId,
                groupIndex: position.groupIndex,
                commandIndex: position.commandIndex
            }) &&
        entry.sourceRecipePath ===
            toRallarBlackBoxParallelChildSourceRecipePath(
                parent.sourceRecipePath,
                position.groupIndex,
                position.commandIndex
            );
}

export function isCommandIdentityConsistent(
    entry: RallarBlackBoxCompositeResultFlatEntry,
    command: RallarBlackBoxTestCommand
): boolean {
    const position = entry.position;
    if (
        position.kind !== 'root' && command.commandId !== undefined && position.originalCommandId !== command.commandId
    ) {
        return false;
    }
    if (position.kind === 'recipe-child' && command.commandId !== undefined && entry.commandId !== command.commandId) {
        return false;
    }
    const value = decodeRecord(entry.result.value);
    return command.kind !== 'rtc.connect' || command.connection === undefined ||
        value.connection === command.connection;
}
