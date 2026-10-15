import type { ControlCommandEnvelope, ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlQueuedCommandSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { bindAcknowledgedControlRecipe } from '@shared-test/rallar-bb-test/control/control-rtc-capture-evidence.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { ControlServiceFailure } from './control-service-failure.ts';
import { toControlCommandSnapshot } from './control-service-snapshots.ts';
import type {
    ControlAgentState,
    ControlCommandState,
    ControlRunState
} from './control-service-state.ts';
import {
    computeControlRecipeReloadStep,
    toControlRecipeReloadDispatch
} from './recipe-reload/compute-control-recipe-reload-step.ts';
import { toControlRecipeReloadOwners } from './recipe-reload/control-recipe-reload-commands.ts';
import { hasControlReloadCleanup, isDispatchableControlReloadCleanup } from './recipe-reload/control-reload-cleanup.ts';

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

/** The run's queued commands and results, each copied at most once and only when first read. */
export interface ControlRunEvidenceView {
    readonly commands: readonly ControlQueuedCommandSnapshot[];
    readonly results: readonly ControlResultEnvelope[];
}

/** One dispatch scan's read of a run, built once per scan and shared by every agent it serves. */
export interface ControlDispatchScan {
    readonly run: ControlRunState;
    readonly commandsByAgentId: ReadonlyMap<string, readonly ControlCommandState[]>;
    readonly reloadOwners: ReadonlyMap<string, ControlCommandState>;
    readonly evidence: ControlRunEvidenceView;
}

export interface ControlAgentDispatchRead {
    readonly scan: ControlDispatchScan;
    readonly agent: ControlAgentState;
    readonly nowEpochMs: number;
}

export interface ControlCommandDispatchEnvelopeInput {
    readonly scan: ControlDispatchScan;
    readonly command: ControlCommandState;
    readonly agent: ControlAgentState;
}

export function toControlRunEvidenceView(run: ControlRunState): ControlRunEvidenceView {
    let commands: readonly ControlQueuedCommandSnapshot[] | undefined;
    let results: readonly ControlResultEnvelope[] | undefined;
    return {
        get commands() {
            commands ??= Array.from(run.commands.values(), toControlCommandSnapshot);
            return commands;
        },
        get results() {
            results ??= Array.from(run.results.values());
            return results;
        }
    };
}

export function toControlDispatchScan(run: ControlRunState): ControlDispatchScan {
    const commandsByAgentId = new Map<string, ControlCommandState[]>();
    for (const command of run.commands.values()) {
        const agentId = command.envelope.agentId;
        const agentCommands = agentId === undefined ? undefined : commandsByAgentId.get(agentId);
        if (agentCommands) {
            agentCommands.push(command);
        }
        else if (agentId !== undefined) {
            commandsByAgentId.set(agentId, [command]);
        }
    }
    return {
        run,
        commandsByAgentId,
        reloadOwners: toControlRecipeReloadOwners(run),
        evidence: toControlRunEvidenceView(run)
    };
}

/** Reads only the agent's own commands, so one scan over every agent reads each queued command once. */
export function computeDispatchableControlCommands(read: ControlAgentDispatchRead): readonly ControlCommandState[] {
    return (read.scan.commandsByAgentId.get(read.agent.agentId) ?? []).filter((command) =>
        isDispatchableControlCommand(read, command)
    );
}

function isDispatchableControlCommand(
    { scan, agent, nowEpochMs }: ControlAgentDispatchRead,
    command: ControlCommandState
): boolean {
    const run = scan.run;
    if (hasControlReloadCleanup(command.envelope)) {
        return isDispatchableControlReloadCleanup(command, run, nowEpochMs);
    }
    const reloadOwner = scan.reloadOwners.get(command.envelope.commandId);
    if (reloadOwner) {
        const step = computeControlRecipeReloadStep({ root: reloadOwner, run, nowEpochMs });
        return step.kind === 'dispatch' && step.envelope.commandId === command.envelope.commandId;
    }
    return command.completedAtEpochMs === undefined &&
        !agent.resumeCompletedCommandIds.has(command.envelope.commandId) &&
        command.lastDispatchedConnectionSequence !== agent.connectionSequence;
}

/** The outgoing body binding is lowered from the current finite queue/ACK facts; authored fingerprints stay unchanged. */
export function toControlCommandDispatchEnvelope(
    { scan, command, agent }: ControlCommandDispatchEnvelopeInput
): ControlCommandEnvelope {
    return bindAcknowledgedControlRecipe({
        command: toControlRecipeReloadDispatch(scan.reloadOwners.get(command.envelope.commandId), command.envelope),
        agentId: agent.agentId,
        commands: scan.evidence.commands,
        results: scan.evidence.results
    });
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
