import { resolveRequiredRtcCaptureFailure } from '@shared-web/browser/connection/browser-rtc-capture-intent.ts';
import { toRtcCaptureReadout } from '@shared-web/browser/connection/to-rtc-capture-readout.ts';
import { parseRtcCaptureMode } from '@shared/webrtc/rtc-capture-configuration.ts';

import {
    toRallarBlackBoxLoopChildResultPath,
    toRallarBlackBoxLoopChildSourceRecipePath,
    toRallarBlackBoxParallelChildResultPath,
    toRallarBlackBoxParallelChildSourceRecipePath
} from '../composite-result-paths.ts';
import {
    decodeRallarBlackBoxTestResult,
    toRallarBlackBoxCompositeResultFlatEntries,
    type RallarBlackBoxCompositeResultFlatEntry
} from '../composite-results.ts';
import type { ControlCommandEnvelope, ControlResultEnvelope } from '../control-protocol.ts';
import type { ControlQueuedCommandSnapshot } from '../control-snapshots.ts';
import type { RallarBlackBoxTestCommand, RallarBlackBoxTestRecipe } from '../rallar-black-box-test-contracts.ts';
import { RecipeCaptureRequirements } from '../recipe/recipe-capture-requirements.ts';
import { RecipeCaptureSequence } from '../recipe/recipe-capture-sequence.ts';
import { decodeJsonValue, decodeRecord, decodeText } from '../runtime/decode-runtime-result-values.ts';

export interface ControlRtcCaptureEvidenceInput {
    readonly command: ControlCommandEnvelope | undefined;
    readonly envelope: ControlResultEnvelope;
    readonly commands: readonly ControlQueuedCommandSnapshot[];
    readonly results: readonly ControlResultEnvelope[];
}

interface CommandAttribution {
    readonly commands: ReadonlyMap<string, RallarBlackBoxTestCommand>;
    readonly recipes: ReadonlyMap<string, RallarBlackBoxTestRecipe>;
}

/** Derives a historical disposition from this finite snapshot, never from sender certification or inferred intent. */
export function toRetainedControlResultEnvelope(
    envelope: ControlResultEnvelope,
    commands: readonly ControlQueuedCommandSnapshot[]
): ControlResultEnvelope {
    return commands.some((command) => command.envelope.commandId === envelope.commandId)
        ? envelope
        : { ...envelope, attribution: { status: 'unavailable', reason: 'queued-command-not-retained' } };
}

/** Application admission uses the queued executable body, never support advertisements or outer success alone. */
export function isAdmissibleControlRtcCaptureResult(input: ControlRtcCaptureEvidenceInput): boolean {
    const command = input.command;
    const envelope = input.envelope;
    if (envelope.attribution?.status === 'unavailable') {
        return false;
    }
    if (!envelope.ok) {
        return true;
    }
    if (!command) {
        return false;
    }
    const execution = toKnownExecutionCommand(input);
    const requirements = toCommandCaptureRequirements(execution);
    if (requirements.entries.length === 0) {
        return true;
    }
    const result = decodeRallarBlackBoxTestResult(envelope.result).right;
    if (
        !result || result.commandId !== command.commandId || result.kind !== command.command.kind ||
        result.ok !== true || result.status !== 'ok' || (envelope.replayed === true) !== (result.replayed === true) ||
        command.runId !== envelope.runId ||
        (command.agentId !== undefined && command.agentId !== envelope.agentId)
    ) {
        return false;
    }
    if (
        execution.kind === 'recipe.run' && execution.expectedRecipeBodyId !== undefined &&
        decodeRecord(decodeRecord(result.value).invocation).recipeBodyId !== execution.expectedRecipeBodyId
    ) {
        return false;
    }
    const entries = toRallarBlackBoxCompositeResultFlatEntries([result]);
    const authored = toAttributedCommands(execution, entries, requirements);
    if (
        entries.some((entry) =>
            entry.childDecodeIssues.length > 0 ||
            decodeRecord(decodeRecord(entry.result.value).resultEvidence).status === 'limited' ||
            !isCompositeAttributionConsistent(entry, entries, authored.commands)
        )
    ) {
        return false;
    }
    return requirements.entries.every((requirement) => {
        const matches = entries.filter((entry) => authored.commands.get(entry.path) === requirement.command);
        return matches.length > 0 && matches.every((entry) =>
            isAttributedCaptureSuccess(entry, requirement) &&
            isCommandIdentityConsistent(entry, requirement.command)
        );
    }) && entries.every((entry) => isRecipeInvocationConsistent(entry, authored, entries));
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

/** Lower only a known required-capture reference; authored queue fingerprints and ordinary local references stay unchanged. */
export function bindAcknowledgedControlRecipe(input: AcknowledgedControlRecipeInput): ControlCommandEnvelope {
    const command = input.command.command;
    if (command.kind !== 'recipe.run' || command.recipe !== undefined || command.expectedRecipeBodyId !== undefined) {
        return input.command;
    }
    const accepted = resolveAcknowledgedControlRecipe(input);
    if (!accepted || toCommandCaptureRequirements({ ...command, recipe: accepted.recipe }).entries.length === 0) {
        return input.command;
    }
    return { ...input.command, command: { ...command, expectedRecipeBodyId: accepted.recipeBodyId } };
}

/** An existing completed load supplies authored commands; this does not certify a content hash or fresh scope. */
function toKnownExecutionCommand(input: ControlRtcCaptureEvidenceInput): RallarBlackBoxTestCommand {
    const queued = input.command;
    const command = queued?.command;
    if (queued === undefined || command === undefined) {
        throw new TypeError('Application admission requires its queued command.');
    }
    if (command.kind !== 'recipe.run' || command.recipe !== undefined) {
        return command;
    }
    const accepted = resolveAcknowledgedControlRecipe({
        command: queued,
        agentId: input.envelope.agentId,
        commands: input.commands,
        results: input.results
    });
    return accepted !== undefined
        ? {
            ...command,
            recipe: accepted.recipe,
            expectedRecipeBodyId: command.expectedRecipeBodyId ?? accepted.recipeBodyId
        }
        : command;
}

function toCommandCaptureRequirements(command: RallarBlackBoxTestCommand): RecipeCaptureRequirements.Analysis {
    const recipe = command.kind === 'recipe.run' ? command.recipe : {
        schemaVersion: 1 as const,
        recipeId: 'control-command',
        commands: [command]
    };
    const analysis = new RecipeCaptureRequirements().analyze({
        selections: [{ recipeId: recipe?.recipeId ?? 'control-reference', recipe, variables: {} }],
        run: command.kind === 'recipe.run' ? command.rtcCaptureMode : undefined
    });
    return command.kind === 'recipe.run' && command.recipe === undefined
        ? { ...analysis, entries: analysis.entries.map((entry) => ({ ...entry, command })) }
        : analysis;
}

/** Indexes only the owned recipe/loop/parallel result shapes already decoded by the composite owner. */
function toAttributedCommands(
    root: RallarBlackBoxTestCommand,
    entries: readonly RallarBlackBoxCompositeResultFlatEntry[],
    requirements: RecipeCaptureRequirements.Analysis
): CommandAttribution {
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
                const bodies = requirements.references.get(child);
                const recipe = child.recipe ?? (bodies?.size === 1 ? [...bodies][0] : undefined);
                if (recipe !== undefined) {
                    recipes.set(entry.path, recipe);
                }
            }
        }
    }
    return { commands, recipes };
}

function isCompositeAttributionConsistent(
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

function isCommandIdentityConsistent(
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

function isAttributedCaptureSuccess(
    entry: RallarBlackBoxCompositeResultFlatEntry,
    requirement: RecipeCaptureRequirements.Entry
): boolean {
    if (!entry.ok || entry.status !== 'ok') {
        return false;
    }
    const readout = toRtcCaptureReadout(decodeJsonValue(decodeRecord(entry.result.value).rtcCapture)).right;
    if (readout?.status !== 'observed') {
        return false;
    }
    return requirement.modes.some((mode) =>
        resolveRequiredRtcCaptureFailure({ ...readout.value.configuration, mode }, readout) === undefined
    );
}

function isRecipeInvocationConsistent(
    entry: RallarBlackBoxCompositeResultFlatEntry,
    authored: CommandAttribution,
    entries: readonly RallarBlackBoxCompositeResultFlatEntry[]
): boolean {
    if (entry.kind !== 'recipe.run') {
        return true;
    }
    const command = authored.commands.get(entry.path);
    const recipe = authored.recipes.get(entry.path);
    if (command?.kind !== 'recipe.run' || recipe === undefined) {
        return false;
    }
    const value = decodeRecord(entry.result.value);
    const invocation = decodeRecord(value.invocation);
    const parent = entries.filter((candidate) =>
        candidate.kind === 'recipe.run' && entry.path.startsWith(`${candidate.path}.`)
    ).at(-1);
    const inherited = decodeRecord(decodeRecord(parent?.result.value).invocation);
    const sequence = new RecipeCaptureSequence({
        run: parseRtcCaptureMode(inherited.run).right?.mode,
        recipe: parseRtcCaptureMode(inherited.recipe).right?.mode,
        step: parseRtcCaptureMode(inherited.step).right?.mode
    });
    const selection = sequence.forRecipe(recipe, command.rtcCaptureMode).get();
    const loaded = command.recipe !== undefined || entries.some((candidate) => {
        const load = authored.commands.get(candidate.path);
        return load?.kind === 'recipe.load' && load.recipe === recipe && candidate.ok && candidate.status === 'ok' &&
            decodeRecord(candidate.result.value).recipeBodyId === invocation.recipeBodyId;
    });
    return decodeText(invocation.invocationId) !== undefined && decodeText(invocation.recipeBodyId) !== undefined &&
        loaded && value.recipeId === recipe.recipeId &&
        invocation.run === selection.run && invocation.recipe === selection.recipe;
}
