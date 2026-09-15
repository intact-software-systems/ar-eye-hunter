import type { ControlCommandEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';

import type { ControlAgentState, ControlCommandState } from './control-service-state.ts';

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

export function isDispatchableControlCommand(command: ControlCommandState, agent: ControlAgentState): boolean {
    return command.envelope.agentId === agent.agentId &&
        command.completedAtEpochMs === undefined &&
        !agent.resumeCompletedCommandIds.has(command.envelope.commandId) &&
        command.lastDispatchedConnectionSequence !== agent.connectionSequence;
}
