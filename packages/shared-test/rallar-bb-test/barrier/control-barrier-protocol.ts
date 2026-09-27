import { Either } from '@shared/resilience/Either.ts';

import { RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION, type ControlClientIdentity } from '../control-protocol.ts';
import type {
    RallarBlackBoxTestBarrierCommand,
    RallarBlackBoxTestRuntimeEventInput
} from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';

export const RALLAR_BLACK_BOX_BARRIER_ARRIVED_TOPIC = 'rallar.bb.barrier.arrived';
export const RALLAR_BLACK_BOX_BARRIER_RESOLVED_TOPIC = 'rallar.bb.barrier.resolved';

export const CONTROL_BARRIER_FAILURE_REASONS = [
    'timed-out',
    'participant-failed',
    'not-a-participant',
    'conflicting-arrival',
    'unknown-participant-role',
    'no-distributed-run'
] as const;

export type ControlBarrierFailureReason = typeof CONTROL_BARRIER_FAILURE_REASONS[number];

/** What an agent reports on reaching a barrier; the control server keys it by the envelope's agent. */
export interface RallarBlackBoxBarrierArrival {
    readonly barrierId: string;
    readonly timeoutMs: number;
    /** Undefined: every target agent the distributed run started takes part. */
    readonly participants: readonly string[] | undefined;
}

export type ControlBarrierResolution =
    | Readonly<{ outcome: 'released'; arrivedAgentIds: readonly string[]; }>
    | Readonly<{
        outcome: 'failed';
        reason: ControlBarrierFailureReason;
        arrivedAgentIds: readonly string[];
        missingAgentIds: readonly string[];
    }>;

/** The one server-to-agent frame that is not a command: it resolves a barrier the agent is waiting at. */
export type ControlBarrierEnvelope = Readonly<{
    kind: 'barrier';
    protocolVersion: 1;
    runId: string;
    agentId: string;
    barrierId: string;
    resolution: ControlBarrierResolution;
}>;

export function toBarrierArrivedEvent(
    command: RallarBlackBoxTestBarrierCommand & Readonly<{ commandId: string; }>
): RallarBlackBoxTestRuntimeEventInput {
    return {
        kind: 'event',
        topic: RALLAR_BLACK_BOX_BARRIER_ARRIVED_TOPIC,
        commandId: command.commandId,
        severity: 'info',
        payload: {
            barrierId: command.barrierId,
            timeoutMs: command.timeoutMs,
            ...(command.participants === undefined ? {} : { participants: [...command.participants] })
        }
    };
}

export function toBarrierResolvedEvent(envelope: ControlBarrierEnvelope): RallarBlackBoxTestRuntimeEventInput {
    return {
        kind: 'event',
        topic: RALLAR_BLACK_BOX_BARRIER_RESOLVED_TOPIC,
        severity: envelope.resolution.outcome === 'released' ? 'info' : 'error',
        payload: { barrierId: envelope.barrierId, resolution: envelope.resolution }
    };
}

/** Reads a forwarded runtime event; anything but a well-formed arrival is Left. */
export function decodeBarrierArrival(event: unknown): Either<string, RallarBlackBoxBarrierArrival> {
    if (
        !isJsonRecordValue(event) || event.topic !== RALLAR_BLACK_BOX_BARRIER_ARRIVED_TOPIC ||
        !isJsonRecordValue(event.payload)
    ) {
        return Either.ofLeft('Not a barrier arrival.');
    }
    const { barrierId, timeoutMs, participants } = event.payload;
    if (
        typeof barrierId !== 'string' || barrierId.length === 0 ||
        typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1
    ) {
        return Either.ofLeft('A barrier arrival names its barrierId and a positive integer timeoutMs.');
    }
    if (participants !== undefined && !isTextList(participants)) {
        return Either.ofLeft('Barrier participants are role names.');
    }
    return Either.ofRight({ barrierId, timeoutMs, participants });
}

export function decodeBarrierResolution(value: unknown): Either<string, ControlBarrierResolution> {
    if (!isJsonRecordValue(value) || !isTextList(value.arrivedAgentIds)) {
        return Either.ofLeft('A barrier resolution names the agents that arrived.');
    }
    const arrivedAgentIds = value.arrivedAgentIds;
    if (value.outcome === 'released') {
        return Either.ofRight({ outcome: 'released', arrivedAgentIds });
    }
    if (value.outcome === 'failed' && isFailureReason(value.reason) && isTextList(value.missingAgentIds)) {
        return Either.ofRight({
            outcome: 'failed',
            reason: value.reason,
            arrivedAgentIds,
            missingAgentIds: value.missingAgentIds
        });
    }
    return Either.ofLeft(
        'A barrier resolution is released, or failed with a known reason and the agents still missing.'
    );
}

export function decodeControlBarrierEnvelope(
    message: unknown,
    expected: ControlClientIdentity
): Either<string, ControlBarrierEnvelope> {
    const record = decodeJsonRecord(message);
    if (record?.kind !== 'barrier' || record.protocolVersion !== RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION) {
        return Either.ofLeft('Not a control barrier envelope.');
    }
    const barrierId = record.barrierId;
    if (record.runId !== expected.runId || record.agentId !== expected.agentId || !isText(barrierId)) {
        return Either.ofLeft('Control barrier envelope does not address this agent.');
    }
    return decodeBarrierResolution(record.resolution).mapRight((resolution) => ({
        kind: 'barrier' as const,
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: expected.runId,
        agentId: expected.agentId,
        barrierId,
        resolution
    }));
}

function decodeJsonRecord(message: unknown): Readonly<Record<string, unknown>> | undefined {
    try {
        const decoded: unknown = typeof message === 'string' ? JSON.parse(message) : message;
        return isJsonRecordValue(decoded) ? decoded : undefined;
    }
    catch {
        return undefined;
    }
}

function isText(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isTextList(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every(isText);
}

function isFailureReason(value: unknown): value is ControlBarrierFailureReason {
    return CONTROL_BARRIER_FAILURE_REASONS.some((reason) => reason === value);
}
