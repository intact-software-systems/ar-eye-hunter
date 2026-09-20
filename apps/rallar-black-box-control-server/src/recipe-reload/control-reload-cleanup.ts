import { hasAlmReloadPair } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import type { ControlCommandEnvelope, ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import type { ControlCommandState, ControlRunState } from '../control-service-state.ts';
import {
    isControlRecipeReloadRoot,
    toControlRecipeReloadCommands
} from './control-recipe-reload-commands.ts';

export interface ControlReloadCleanupRead {
    readonly root: ControlCommandState;
    readonly run: ControlRunState;
    readonly deadlineEpochMs: number;
}

/** Capture active work or the last successful retained-resource owner before logical completion. */
export function toControlReloadCleanup(read: ControlReloadCleanupRead): ControlCommandEnvelope | undefined {
    const root = read.root.envelope;
    if (!hasAlmReloadPair(root.command) || !isControlRecipeReloadRoot(root)) {
        return undefined;
    }
    const target = toControlRecipeReloadCommands(root).toReversed()
        .flatMap((child) => read.run.commands.get(child.commandId) ?? [])
        .find((child) => child.dispatchCount > 0 && child.envelope.command.kind === 'recipe.run');
    if (!target || target.lastDispatchedConnectionSequence === undefined) {
        return undefined;
    }
    const result = read.run.results.get(target.envelope.commandId);
    if (result && !result.ok) {
        return undefined;
    }
    return toCleanupEnvelope({
        owner: root,
        cleanup: {
            rootCommandId: root.commandId,
            targetCommandId: target.envelope.commandId,
            connectionSequence: target.lastDispatchedConnectionSequence
        },
        kind: result ? 'close' : 'recipe.cancel',
        deadlineEpochMs: read.deadlineEpochMs
    });
}

/** A target can finish between queue and execution. One exact idle close may follow an actual cancel refusal. */
export function toControlReloadCleanupSuccessor(
    command: ControlCommandState,
    result: ControlResultEnvelope
): ControlCommandEnvelope | undefined {
    const cleanup = toControlReloadCleanupMetadata(command.envelope);
    return cleanup && isActualCancelRefusal(command, result)
        ? toCleanupEnvelope({
            owner: command.envelope,
            cleanup,
            kind: 'close',
            deadlineEpochMs: command.envelope.deadlineEpochMs!
        })
        : undefined;
}

export function isDispatchableControlReloadCleanup(
    command: ControlCommandState,
    run: ControlRunState,
    nowEpochMs: number
): boolean {
    return command.dispatchCount === 0 && command.completedAtEpochMs === undefined &&
        command.envelope.deadlineEpochMs !== undefined && nowEpochMs < command.envelope.deadlineEpochMs &&
        hasAvailableCleanupTarget(command, run);
}

export function isAdmissibleControlReloadCleanupResult(
    command: ControlCommandState,
    result: ControlResultEnvelope
): boolean {
    const cleanup = toControlReloadCleanupMetadata(command.envelope);
    const value = result.result?.value;
    return cleanup !== undefined && command.dispatchCount > 0 && command.completedAtEpochMs === undefined &&
        result.commandId === command.envelope.commandId && result.runId === command.envelope.runId &&
        result.agentId === command.envelope.agentId && result.result?.commandId === result.commandId &&
        result.result.kind === command.envelope.command.kind && result.result.ok === result.ok &&
        (result.result.status === 'ok') === result.ok &&
        (!result.ok || (isJsonRecordValue(value) && (command.envelope.command.kind === 'close'
            ? typeof value.closed === 'boolean'
            : typeof value.cancelRequested === 'boolean' && value.targetCommandId === cleanup.targetCommandId)));
}

/** A refused cleanup is a control decision, never evidence that browser cleanup happened. */
export function computeControlReloadCleanupRefusal(
    command: ControlCommandState,
    run: ControlRunState,
    nowEpochMs: number
): ControlResultEnvelope | undefined {
    if (!hasControlReloadCleanup(command.envelope) || command.completedAtEpochMs !== undefined) {
        return undefined;
    }
    const agent = run.agents.get(command.envelope.agentId ?? '');
    const code = command.envelope.deadlineEpochMs === undefined || nowEpochMs >= command.envelope.deadlineEpochMs
        ? 'RALLAR_BLACK_BOX_RELOAD_CLEANUP_EXPIRED'
        : command.dispatchCount > 0
        ? (!agent?.connected || command.lastDispatchedConnectionSequence !== agent.connectionSequence
            ? 'RALLAR_BLACK_BOX_RELOAD_CLEANUP_UNOBSERVABLE'
            : undefined)
        : !hasAvailableCleanupTarget(command, run)
        ? 'RALLAR_BLACK_BOX_RELOAD_CLEANUP_TARGET_UNAVAILABLE'
        : undefined;
    if (!code) {
        return undefined;
    }
    const cleanup = toControlReloadCleanupMetadata(command.envelope);
    return {
        kind: 'result',
        protocolVersion: 1,
        runId: run.runId,
        agentId: command.envelope.agentId!,
        commandId: command.envelope.commandId,
        ok: false,
        result: {
            commandId: command.envelope.commandId,
            kind: command.envelope.command.kind,
            ok: false,
            status: 'failed',
            startedAtEpochMs: command.queuedAtEpochMs,
            endedAtEpochMs: nowEpochMs,
            durationMs: Math.max(0, nowEpochMs - command.queuedAtEpochMs),
            value: {
                ...(command.dispatchCount > 0
                    ? {}
                    : command.envelope.command.kind === 'close'
                    ? { closed: false }
                    : { cancelRequested: false }),
                targetCommandId: cleanup?.targetCommandId
            },
            error: {
                code,
                message: command.dispatchCount > 0
                    ? 'The dispatched cleanup result is unavailable; its browser effect is unobservable.'
                    : 'The owned reload cleanup could not be dispatched safely.'
            }
        }
    };
}

function hasAvailableCleanupTarget(command: ControlCommandState, run: ControlRunState): boolean {
    const cleanup = toControlReloadCleanupMetadata(command.envelope);
    if (!cleanup) {
        return false;
    }
    const target = run.commands.get(cleanup.targetCommandId);
    const root = run.commands.get(cleanup.rootCommandId);
    const agent = run.agents.get(command.envelope.agentId ?? '');
    if (
        !target || !root || agent?.connected !== true || agent.connectionSequence !== cleanup.connectionSequence ||
        target.dispatchCount === 0 || target.lastDispatchedConnectionSequence !== cleanup.connectionSequence ||
        target.envelope.agentId !== command.envelope.agentId || !isControlRecipeReloadRoot(root.envelope) ||
        !toControlRecipeReloadCommands(root.envelope).some((child) => child.commandId === cleanup.targetCommandId)
    ) {
        return false;
    }
    const targetResult = run.results.get(cleanup.targetCommandId);
    if (command.envelope.command.kind === 'recipe.cancel') {
        return targetResult === undefined;
    }
    const cancellationId = toControlReloadCleanupId(cleanup, 'recipe.cancel');
    const cancellation = run.commands.get(cancellationId);
    const cancellationResult = run.results.get(cancellationId);
    return targetResult?.ok === true ||
        (cancellation !== undefined && cancellationResult !== undefined &&
            isActualCancelRefusal(cancellation, cancellationResult));
}

function isActualCancelRefusal(command: ControlCommandState, result: ControlResultEnvelope): boolean {
    const cleanup = toControlReloadCleanupMetadata(command.envelope);
    return cleanup !== undefined && command.envelope.command.kind === 'recipe.cancel' && command.dispatchCount > 0 &&
        result.commandId === command.envelope.commandId && result.agentId === command.envelope.agentId &&
        result.runId === command.envelope.runId && result.ok && result.result?.ok === true &&
        result.result.kind === 'recipe.cancel' && result.result.commandId === result.commandId &&
        isJsonRecordValue(result.result.value) && result.result.value.cancelRequested === false &&
        result.result.value.targetCommandId === cleanup.targetCommandId;
}

interface CleanupEnvelopeInput {
    readonly owner: ControlCommandEnvelope;
    readonly cleanup: ControlReloadCleanup;
    readonly kind: 'recipe.cancel' | 'close';
    readonly deadlineEpochMs: number;
}

function toCleanupEnvelope({ owner, cleanup, kind, deadlineEpochMs }: CleanupEnvelopeInput): ControlCommandEnvelope {
    const commandId = toControlReloadCleanupId(cleanup, kind);
    return {
        kind: 'command',
        protocolVersion: 1,
        runId: owner.runId,
        agentId: owner.agentId,
        commandId,
        deadlineEpochMs,
        command: {
            kind,
            commandId,
            targetCommandId: cleanup.targetCommandId,
            metadata: { almReloadCleanup: cleanup },
            ...(kind === 'recipe.cancel' ? { reason: 'Paired reload stopped.' } : {})
        }
    };
}

export interface ControlReloadCleanup {
    readonly rootCommandId: string;
    readonly targetCommandId: string;
    readonly connectionSequence: number;
}

export function hasControlReloadCleanup(envelope: ControlCommandEnvelope): boolean {
    return envelope.command.metadata !== undefined && Object.hasOwn(envelope.command.metadata, 'almReloadCleanup');
}

export function toControlReloadCleanupMetadata(envelope: ControlCommandEnvelope): ControlReloadCleanup | undefined {
    const value = envelope.command.metadata?.almReloadCleanup;
    return (envelope.command.kind === 'recipe.cancel' || envelope.command.kind === 'close') &&
            isJsonRecordValue(value) &&
            typeof value.rootCommandId === 'string' && typeof value.targetCommandId === 'string' &&
            envelope.command.targetCommandId === value.targetCommandId &&
            typeof value.connectionSequence === 'number' && Number.isSafeInteger(value.connectionSequence)
        ? {
            rootCommandId: value.rootCommandId,
            targetCommandId: value.targetCommandId,
            connectionSequence: value.connectionSequence
        }
        : undefined;
}

export function toControlReloadCleanupId(cleanup: ControlReloadCleanup, kind: 'recipe.cancel' | 'close'): string {
    return `alm-reload-cleanup:${JSON.stringify([cleanup.rootCommandId, cleanup.targetCommandId, kind])}`;
}
