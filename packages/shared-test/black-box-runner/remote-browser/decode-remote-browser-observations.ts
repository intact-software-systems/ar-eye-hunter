import type {
    ApiJsonObject,
    ApiJsonValue
} from '../../../shared/api/api-json-value.ts';
import { Either } from '../../../shared/resilience/Either.ts';

import {
    parseControlClientMessage,
    type ControlClientEnvelope,
    type ControlEventEnvelope,
    type ControlResultEnvelope
} from '../../rallar-bb-test/control-protocol.ts';
import type {
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestEventKind,
    RallarBlackBoxTestSeverity
} from '../../rallar-bb-test/rallar-black-box-test-contracts.ts';
import {
    decodeFiniteNumber,
    decodeTransport
} from '../../rallar-bb-test/runtime/decode-runtime-result-values.ts';

export interface RemoteBrowserObservationEvent extends ControlEventEnvelope {
    readonly payload: RallarBlackBoxTestEvent<ApiJsonValue>;
}

export interface RemoteBrowserObservations {
    readonly runId: string;
    readonly results: readonly ControlResultEnvelope[];
    readonly events: readonly RemoteBrowserObservationEvent[];
}

const EVENT_KINDS: readonly RallarBlackBoxTestEventKind[] = [
    'event',
    'diagnostic',
    'message',
    'stats',
    'report',
    'result',
    'state'
];

const SEVERITIES: readonly RallarBlackBoxTestSeverity[] = ['debug', 'info', 'warning', 'error'];

/** Decode only the HTTP snapshot fields consumed by command and observation polling. */
export function decodeRemoteBrowserObservations(
    value: ApiJsonValue,
    runId: string
): Either<Error, RemoteBrowserObservations> {
    if (
        !isApiJsonObject(value) || value.runId !== runId || !Array.isArray(value.results) ||
        !Array.isArray(value.events)
    ) {
        return toSnapshotIssue('expected matching runId and result/event arrays');
    }
    const results: ControlResultEnvelope[] = [];
    for (const raw of value.results) {
        const parsed = parseControlClientMessage(raw);
        if (!parsed.ok || parsed.envelope.kind !== 'result' || parsed.envelope.runId !== runId) {
            return toSnapshotIssue('invalid result envelope');
        }
        results.push(parsed.envelope);
    }
    const events: RemoteBrowserObservationEvent[] = [];
    for (const raw of value.events) {
        const event = decodeObservationEvent(raw, runId);
        if (event.left !== undefined) {
            return Either.ofLeft(event.left);
        }
        event.foldRight((decoded) => events.push(decoded));
    }
    return Either.ofRight({ runId, results, events });
}

function decodeObservationEvent(raw: ApiJsonValue, runId: string): Either<Error, RemoteBrowserObservationEvent> {
    const parsed = parseControlClientMessage(raw);
    if (!parsed.ok || !isEventEnvelope(parsed.envelope) || parsed.envelope.runId !== runId || !isApiJsonObject(raw)) {
        return toSnapshotIssue('invalid event envelope');
    }
    const envelope = parsed.envelope;
    return decodeEventProjection(raw.payload).mapRight((payload) => ({ ...envelope, payload }));
}

function decodeEventProjection(value: ApiJsonValue | undefined): Either<Error, RallarBlackBoxTestEvent<ApiJsonValue>> {
    if (!isApiJsonObject(value)) {
        return toSnapshotIssue('invalid event projection');
    }
    const { eventId, kind, topic, commandId, connection, actor, transport, severity, payload } = value;
    const atEpochMs = decodeFiniteNumber(value.atEpochMs);
    const decodedKind = EVENT_KINDS.find((member) => member === kind);
    if (
        decodedKind === undefined || typeof eventId !== 'string' || typeof topic !== 'string' || atEpochMs === undefined
    ) {
        return toSnapshotIssue('invalid event projection');
    }
    const invalidText = (['connection', 'actor', 'commandId'] as const)
        .find((field) => value[field] !== undefined && typeof value[field] !== 'string');
    if (invalidText !== undefined) {
        return toSnapshotIssue(`invalid event ${invalidText}`);
    }
    const decodedTransport = decodeTransport(transport);
    if (transport !== undefined && decodedTransport === undefined) {
        return toSnapshotIssue('invalid event transport');
    }
    const decodedSeverity = SEVERITIES.find((member) => member === severity);
    if (severity !== undefined && decodedSeverity === undefined) {
        return toSnapshotIssue('invalid event severity');
    }
    return Either.ofRight({
        eventId,
        kind: decodedKind,
        topic,
        atEpochMs,
        ...(typeof commandId === 'string' ? { commandId } : {}),
        ...(typeof connection === 'string' ? { connection } : {}),
        ...(typeof actor === 'string' ? { actor } : {}),
        ...(decodedTransport === undefined ? {} : { transport: decodedTransport }),
        ...(decodedSeverity === undefined ? {} : { severity: decodedSeverity }),
        ...(payload === undefined ? {} : { payload })
    });
}

function isApiJsonObject(value: ApiJsonValue | undefined): value is ApiJsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEventEnvelope(value: ControlClientEnvelope): value is ControlEventEnvelope {
    return value.kind === 'event' || value.kind === 'diagnostic' || value.kind === 'stats' || value.kind === 'report';
}

function toSnapshotIssue<Decoded>(issue: string): Either<Error, Decoded> {
    return Either.ofLeft(new Error(`Invalid remote browser snapshot: ${issue}.`));
}
