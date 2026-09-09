import {
    parseControlClientMessage,
    type ControlClientEnvelope,
    type ControlEventEnvelope,
    type ControlResultEnvelope
} from '../../rallar-bb-test/control-protocol.ts';

import type { RallarBlackBoxTestEvent } from '../../rallar-bb-test/types.ts';

export interface RemoteBrowserObservationEvent extends ControlEventEnvelope {
    readonly payload: RallarBlackBoxTestEvent;
}

export interface RemoteBrowserObservations {
    readonly runId: string;
    readonly results: readonly ControlResultEnvelope[];
    readonly events: readonly RemoteBrowserObservationEvent[];
}

export interface DecodeRemoteBrowserObservationsInput {
    readonly value: unknown;
    readonly runId: string;
}

/** Decode only the HTTP snapshot fields consumed by command and observation polling. */
export function decodeRemoteBrowserObservations(
    input: DecodeRemoteBrowserObservationsInput
): RemoteBrowserObservations {
    const { value, runId } = input;
    if (!isRecord(value) || value.runId !== runId || !Array.isArray(value.results) || !Array.isArray(value.events)) {
        throw new Error('Invalid remote browser snapshot: expected matching runId and result/event arrays.');
    }
    const results = value.results.map((raw) => {
        const parsed = parseControlClientMessage(raw);
        if (!parsed.ok || parsed.envelope.kind !== 'result' || parsed.envelope.runId !== runId) {
            throw new Error('Invalid remote browser snapshot: invalid result envelope.');
        }
        return parsed.envelope;
    });
    const events = value.events.map((raw) => {
        const parsed = parseControlClientMessage(raw);
        if (!parsed.ok || !isEventEnvelope(parsed.envelope) || parsed.envelope.runId !== runId) {
            throw new Error('Invalid remote browser snapshot: invalid event envelope.');
        }
        return { ...parsed.envelope, payload: decodeEventProjection(parsed.envelope.payload) };
    });
    return { runId, results, events };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEventEnvelope(value: ControlClientEnvelope): value is ControlEventEnvelope {
    return value.kind === 'event' || value.kind === 'diagnostic' || value.kind === 'stats' || value.kind === 'report';
}

function decodeEventProjection(value: unknown): RallarBlackBoxTestEvent {
    if (
        !isRecord(value) ||
        typeof value.kind !== 'string' ||
        !['event', 'diagnostic', 'message', 'stats', 'report', 'result', 'state'].includes(value.kind) ||
        typeof value.eventId !== 'string' ||
        typeof value.topic !== 'string' ||
        typeof value.atEpochMs !== 'number' || !Number.isFinite(value.atEpochMs)
    ) {
        throw new Error('Invalid remote browser snapshot: invalid event projection.');
    }
    for (const field of ['connection', 'actor', 'commandId']) {
        if (value[field] !== undefined && typeof value[field] !== 'string') {
            throw new Error(`Invalid remote browser snapshot: invalid event ${field}.`);
        }
    }
    if (
        value.transport !== undefined &&
        (typeof value.transport !== 'string' ||
            !['realtime', 'messages.rtc', 'messages.ws', 'ws', 'http'].includes(value.transport))
    ) {
        throw new Error('Invalid remote browser snapshot: invalid event transport.');
    }
    if (
        value.severity !== undefined &&
        (typeof value.severity !== 'string' || !['debug', 'info', 'warning', 'error'].includes(value.severity))
    ) {
        throw new Error('Invalid remote browser snapshot: invalid event severity.');
    }
    return value as RallarBlackBoxTestEvent;
}
