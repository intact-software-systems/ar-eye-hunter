import { resolveRequiredRtcCaptureFailure } from '@shared-web/browser/connection/browser-rtc-capture-intent.ts';
import { toRtcCaptureReadout } from '@shared-web/browser/connection/to-rtc-capture-readout.ts';
import { parseRtcCaptureMode } from '@shared/webrtc/rtc-capture-configuration.ts';

import {
    decodeRallarBlackBoxTestResult,
    toRallarBlackBoxCompositeResultFlatEntries,
    type RallarBlackBoxCompositeResultFlatEntry
} from '../composite-results.ts';
import type { ControlCommandEnvelope, ControlResultEnvelope } from '../control-protocol.ts';
import type { ControlQueuedCommandSnapshot } from '../control-snapshots.ts';
import type { RallarBlackBoxTestCommand } from '../rallar-black-box-test-contracts.ts';
import { RecipeCaptureRequirements } from '../recipe/recipe-capture-requirements.ts';
import { RecipeCaptureSequence } from '../recipe/recipe-capture-sequence.ts';
import { decodeJsonValue, decodeRecord, decodeText } from '../runtime/decode-runtime-result-values.ts';
import {
    isCommandIdentityConsistent,
    isCompositeAttributionConsistent,
    resolveAcknowledgedControlRecipe,
    resolveControlExecutionCommand,
    toControlCommandAttribution,
    type AcknowledgedControlRecipeInput,
    type ControlCommandAttribution,
    type ControlCommandEvidenceInput
} from './control-command-attribution.ts';

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
export function isAdmissibleControlRtcCaptureResult(input: ControlCommandEvidenceInput): boolean {
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
    const execution = resolveControlExecutionCommand(input);
    if (execution === undefined) {
        return false;
    }
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
    const authored = toControlCommandAttribution(execution, entries, requirements.references);
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
    authored: ControlCommandAttribution,
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
