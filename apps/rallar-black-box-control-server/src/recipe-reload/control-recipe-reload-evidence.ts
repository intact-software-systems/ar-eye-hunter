import type { ControlCommandEnvelope, ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import {
    RALLAR_BLACK_BOX_TEST_COMMAND_KINDS,
    RALLAR_BLACK_BOX_TEST_RESULT_STATUSES,
    type RallarBlackBoxTestResult
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import { toCompactedResultEnvelope } from '../control-evidence-compaction.ts';
import type { ControlCommandState, ControlRunState } from '../control-service-state.ts';
import {
    isControlRecipeReloadRoot,
    isReloadChildEnvelope,
    toControlRecipeReloadCommands,
    type ControlRecipeReloadRoot
} from './control-recipe-reload-commands.ts';

export interface ControlRecipeReloadRead {
    readonly root: ControlCommandState;
    readonly run: ControlRunState;
    readonly nowEpochMs: number;
}

export type ControlRecipeReloadStep =
    | { readonly kind: 'wait'; }
    | { readonly kind: 'queue' | 'dispatch'; readonly envelope: ControlCommandEnvelope; }
    | ControlRecipeReloadCompletion;

export interface ControlRecipeReloadCompletion {
    readonly kind: 'complete';
    readonly envelope: ControlResultEnvelope;
}

export interface ControlRecipeReloadCompletionWrite {
    readonly commands: readonly ControlCommandState[];
    readonly results: readonly ControlResultEnvelope[];
}

export interface ControlRecipeReloadResultRead {
    readonly owner: ControlCommandState | undefined;
    readonly command: ControlCommandState | undefined;
    readonly envelope: ControlResultEnvelope;
    readonly existingResult: ControlResultEnvelope | undefined;
}

export function isAdmissibleControlRecipeReloadResult(read: ControlRecipeReloadResultRead): boolean {
    return read.owner === undefined || (
        read.owner !== read.command && read.owner.completedAtEpochMs === undefined &&
        read.command !== undefined && read.existingResult === undefined &&
        isControlRecipeReloadRoot(read.owner.envelope) &&
        toControlRecipeReloadCommands(read.owner.envelope).some((child) =>
            isReloadChildEnvelope(child, read.command!.envelope)
        ) &&
        isControlRecipeReloadResult(read.command, read.envelope)
    );
}

export function computeControlRecipeReloadCompletionWrite(
    read: ControlRecipeReloadRead,
    envelope: ControlResultEnvelope
): ControlRecipeReloadCompletionWrite {
    const children = isControlRecipeReloadRoot(read.root.envelope)
        ? toControlRecipeReloadCommands(read.root.envelope)
        : [];
    const commands = [read.root, ...children.flatMap((child) => read.run.commands.get(child.commandId) ?? [])]
        .map((command) => ({ ...command, completedAtEpochMs: command.completedAtEpochMs ?? read.nowEpochMs }));
    const results = children.flatMap((child) => {
        const result = read.run.results.get(child.commandId);
        return result ? [toCompactedResultEnvelope(result)] : [];
    });
    return { commands, results: [...results, envelope] };
}

export function isControlRecipeReloadResult(command: ControlCommandState, envelope: ControlResultEnvelope): boolean {
    const result = envelope.result;
    if (
        command.dispatchCount === 0 || envelope.runId !== command.envelope.runId ||
        envelope.agentId !== command.envelope.agentId ||
        envelope.commandId !== command.envelope.commandId || !isReloadChildResult(result) ||
        result.commandId !== envelope.commandId ||
        result.kind !== command.envelope.command.kind || result.ok !== envelope.ok ||
        (result.status === 'ok') !== result.ok
    ) {
        return false;
    }
    if (command.envelope.command.kind === 'agent.reload') {
        return !result.ok || (isJsonRecordValue(result.value) && result.value.reloading === true);
    }
    const children = toReloadSegmentResults(result);
    const expected = command.envelope.command.kind === 'recipe.run'
        ? command.envelope.command.recipe?.commands
        : undefined;
    if (
        !children || !expected || !isJsonRecordValue(result.value) ||
        result.value.recipeId !==
            (command.envelope.command.kind === 'recipe.run' ? command.envelope.command.recipe?.recipeId : undefined) ||
        children.length > expected.length ||
        (result.ok && children.length !== expected.length)
    ) {
        return false;
    }
    return children.every((child, index) =>
        child.commandId === expected[index].commandId && child.kind === expected[index].kind && (!result.ok || child.ok)
    );
}

export function toReloadCompletion(
    read: ControlRecipeReloadRead,
    status: 'ok' | 'failed' | 'cancelled',
    errorCode: string | undefined
): ControlRecipeReloadCompletion {
    const root = read.root.envelope;
    const results = isControlRecipeReloadRoot(root) ? toActualReloadResults(root, read.run) : [];
    const startedAtEpochMs = read.root.dispatchedAtEpochMs ?? read.root.queuedAtEpochMs;
    const endedAtEpochMs = read.nowEpochMs;
    return {
        kind: 'complete',
        envelope: {
            kind: 'result',
            protocolVersion: 1,
            runId: root.runId,
            agentId: root.agentId!,
            commandId: root.commandId,
            ok: status === 'ok',
            result: {
                commandId: root.commandId,
                kind: 'recipe.run',
                status,
                ok: status === 'ok',
                startedAtEpochMs,
                endedAtEpochMs,
                durationMs: Math.max(0, endedAtEpochMs - startedAtEpochMs),
                value: {
                    recipeId: root.command.kind === 'recipe.run' ? root.command.recipe?.recipeId : undefined,
                    results
                },
                error: errorCode
                    ? { code: errorCode, message: 'ALM reload recipe stopped before successful completion.' }
                    : undefined
            }
        }
    };
}

function toActualReloadResults(
    root: ControlRecipeReloadRoot,
    run: ControlRunState
): readonly RallarBlackBoxTestResult[] {
    return toControlRecipeReloadCommands(root).flatMap((child) => {
        const command = run.commands.get(child.commandId);
        const envelope = run.results.get(child.commandId);
        if (!command || !envelope || !isControlRecipeReloadResult(command, envelope) || !envelope.result) {
            return [];
        }
        return child.command.kind === 'agent.reload'
            ? [envelope.result]
            : toReloadSegmentResults(envelope.result) ?? [];
    });
}

function toReloadSegmentResults(result: RallarBlackBoxTestResult): readonly RallarBlackBoxTestResult[] | undefined {
    if (
        !isJsonRecordValue(result.value) || !Array.isArray(result.value.results) ||
        !result.value.results.every(isReloadChildResult)
    ) {
        return undefined;
    }
    return result.value.results;
}

function isReloadChildResult(value: unknown): value is RallarBlackBoxTestResult {
    return isJsonRecordValue(value) && typeof value.commandId === 'string' &&
        RALLAR_BLACK_BOX_TEST_COMMAND_KINDS.some((kind) => kind === value.kind) &&
        typeof value.ok === 'boolean' &&
        RALLAR_BLACK_BOX_TEST_RESULT_STATUSES.some((status) => status === value.status) &&
        (value.status === 'ok') === value.ok &&
        typeof value.startedAtEpochMs === 'number' && Number.isFinite(value.startedAtEpochMs) &&
        typeof value.endedAtEpochMs === 'number' && Number.isFinite(value.endedAtEpochMs) &&
        value.endedAtEpochMs >= value.startedAtEpochMs &&
        typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0;
}
