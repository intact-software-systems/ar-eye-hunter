import type { ControlCommandEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { ControlServiceFailure } from './control-service.ts';

import type { ControlAgentState, ControlCommandState, ControlRunState } from './control-service-state.ts';
import { computeControlRecipeReloadStep } from './recipe-reload/compute-control-recipe-reload-step.ts';
import { resolveControlRecipeReloadOwner } from './recipe-reload/control-recipe-reload-commands.ts';

export interface ControlCommandRateWindowInput {
    readonly enqueueTimestamps: readonly number[];
    readonly nowEpochMs: number;
    readonly maxCommands: number;
    readonly windowMs: number;
}

export interface ControlCommandRateWindow {
    readonly enqueueTimestamps: readonly number[];
    readonly limited: boolean;
}

export function toControlCommandFingerprint(envelope: ControlCommandEnvelope): string {
    return JSON.stringify({
        command: envelope.command,
        deadlineEpochMs: envelope.deadlineEpochMs
    });
}

export function computeControlCommandRateWindow(input: ControlCommandRateWindowInput): ControlCommandRateWindow {
    if (input.maxCommands <= 0) {
        return { enqueueTimestamps: input.enqueueTimestamps, limited: false };
    }
    const windowStart = input.nowEpochMs - input.windowMs;
    const retained = input.enqueueTimestamps.filter((timestamp) => timestamp >= windowStart);
    return retained.length >= input.maxCommands
        ? { enqueueTimestamps: retained, limited: true }
        : { enqueueTimestamps: [...retained, input.nowEpochMs], limited: false };
}

export function toCommandIdSegment(value: string, emptyFallback: string): string {
    return value.trim().replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '') || emptyFallback;
}

export interface ControlCommandDispatchRead {
    readonly command: ControlCommandState;
    readonly agent: ControlAgentState;
    readonly run: ControlRunState;
    readonly nowEpochMs: number;
}

export function isDispatchableControlCommand({ command, agent, run, nowEpochMs }: ControlCommandDispatchRead): boolean {
    const owner = resolveControlRecipeReloadOwner(run, command.envelope.commandId);
    if (owner) {
        const step = computeControlRecipeReloadStep({ root: owner, run, nowEpochMs });
        return step.kind === 'dispatch' && step.envelope.commandId === command.envelope.commandId &&
            command.envelope.agentId === agent.agentId;
    }
    return command.envelope.agentId === agent.agentId &&
        command.completedAtEpochMs === undefined &&
        !agent.resumeCompletedCommandIds.has(command.envelope.commandId) &&
        command.lastDispatchedConnectionSequence !== agent.connectionSequence;
}

export interface ControlCommandQueueRead {
    readonly envelope: ControlCommandEnvelope;
    readonly existing: ControlCommandState | undefined;
    readonly allowedKinds: ReadonlySet<string> | undefined;
    readonly rate: ControlCommandRateWindowInput;
}

export interface ControlCommandQueueWrite {
    readonly result: Either<ControlServiceFailure, ControlCommandEnvelope>;
    readonly command: ControlCommandState | undefined;
    readonly enqueueTimestamps: readonly number[];
}

export function computeControlCommandQueueWrite(read: ControlCommandQueueRead): ControlCommandQueueWrite {
    const { envelope, existing, allowedKinds, rate } = read;
    const unchanged = { command: undefined, enqueueTimestamps: rate.enqueueTimestamps };
    if (allowedKinds && !allowedKinds.has(envelope.command.kind)) {
        return {
            ...unchanged,
            result: Either.ofLeft({
                code: 'command-kind-not-allowed',
                message: `Command kind is not allowed: ${envelope.command.kind}.`
            })
        };
    }
    const fingerprint = toControlCommandFingerprint(envelope);
    if (existing) {
        return {
            ...unchanged,
            result: existing.fingerprint === fingerprint && existing.envelope.agentId === envelope.agentId
                ? Either.ofRight(existing.envelope)
                : Either.ofLeft({
                    code: 'command-payload-conflict',
                    message: `Command ${envelope.commandId} already exists with a different payload.`
                })
        };
    }
    const window = computeControlCommandRateWindow(rate);
    if (window.limited) {
        return {
            command: undefined,
            enqueueTimestamps: window.enqueueTimestamps,
            result: Either.ofLeft({ code: 'command-rate-limited', message: 'Command rate limit exceeded.' })
        };
    }
    return {
        result: Either.ofRight(envelope),
        command: { envelope, fingerprint, queuedAtEpochMs: rate.nowEpochMs, dispatchCount: 0 },
        enqueueTimestamps: window.enqueueTimestamps
    };
}
