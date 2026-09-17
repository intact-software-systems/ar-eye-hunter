import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';
import { Either } from '@shared/resilience/Either.ts';

import { validateRallarBlackBoxTestCommand } from './control/validate-rallar-black-box-test-command.ts';
import type { RallarBlackBoxControlAgentIdentity } from './distributed-run.ts';
import { decodeControlAgentIdentity } from './distributed/decode-control-agent-identity.ts';
import {
    type RallarBlackBoxTestCommand,
    type RallarBlackBoxTestEvent,
    type RallarBlackBoxTestResult
} from './rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from './schema/json-schema-validation.ts';

export const RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION = 1;

export type ControlCommandEnvelope = Readonly<{
    kind: 'command';
    protocolVersion: 1;
    runId: string;
    agentId?: string;
    commandId: string;
    command: RallarBlackBoxTestCommand;
    deadlineEpochMs?: number;
}>;

export type ControlRegisterEnvelope = Readonly<{
    kind: 'register';
    protocolVersion: 1;
    runId: string;
    agentId: string;
    token?: string;
    atEpochMs: number;
    identity?: RallarBlackBoxControlAgentIdentity;
    resume: Readonly<{
        completedCommandIds: readonly string[];
    }>;
}>;

export type ControlHeartbeatEnvelope = Readonly<{
    kind: 'heartbeat';
    protocolVersion: 1;
    runId: string;
    agentId: string;
    atEpochMs: number;
    status: string;
    identity?: RallarBlackBoxControlAgentIdentity;
    lastCommandId?: string;
    lastEventAtEpochMs?: number;
}>;

export type ControlResultEnvelope = Readonly<{
    kind: 'result';
    protocolVersion: 1;
    runId: string;
    agentId: string;
    commandId: string;
    ok: boolean;
    result?: RallarBlackBoxTestResult;
    error?: Readonly<{
        code: string;
        message: string;
        details?: unknown;
    }>;
    replayed?: boolean;
}>;

export type ControlEventEnvelope = Readonly<{
    kind: 'event' | 'diagnostic' | 'stats' | 'report';
    protocolVersion: 1;
    runId: string;
    agentId: string;
    atEpochMs: number;
    eventId?: string;
    commandId?: string;
    payload: unknown;
}>;

export type ControlClientEnvelope =
    | ControlRegisterEnvelope
    | ControlHeartbeatEnvelope
    | ControlResultEnvelope
    | ControlEventEnvelope;

export type ParseControlMessageResult =
    | Readonly<{ ok: true; envelope: ControlCommandEnvelope; }>
    | Readonly<{ ok: false; error: string; issues?: readonly RallarValidationIssue[]; }>;

export type ParseControlClientMessageResult =
    | Readonly<{ ok: true; envelope: ControlClientEnvelope; }>
    | Readonly<{ ok: false; error: string; }>;

export interface ControlClientIdentity {
    readonly runId: string;
    readonly agentId: string;
}

type ControlEnvelopeRecord = Readonly<Record<string, unknown>>;

type ControlEnvelopeRecordResult =
    | Readonly<{ ok: true; value: ControlEnvelopeRecord; }>
    | Readonly<{ ok: false; error: string; }>;

type ControlCommandAddressResult =
    | Readonly<{ ok: true; agentId: string | undefined; commandId: string; }>
    | Readonly<{ ok: false; error: string; }>;

export function parseControlServerMessage(
    message: unknown,
    expected: ControlClientIdentity
): ParseControlMessageResult {
    const input = decodeControlEnvelopeRecord(message, 'Control message');
    if (!input.ok) {
        return input;
    }
    const envelope = input.value;
    const address = decodeControlCommandAddress(envelope, expected);
    if (!address.ok) {
        return address;
    }

    const commandValidation = validateRallarBlackBoxTestCommand(envelope.command);
    if (!commandValidation.ok) {
        return {
            ok: false,
            error: `Control command payload is invalid: ${commandValidation.error}`,
            issues: commandValidation.issues
        };
    }
    const deadlineEpochMs = envelope.deadlineEpochMs;
    if (deadlineEpochMs !== undefined && typeof deadlineEpochMs !== 'number') {
        return { ok: false, error: 'Control command deadlineEpochMs must be a number.' };
    }

    return {
        ok: true,
        envelope: {
            kind: 'command',
            protocolVersion: 1,
            runId: expected.runId,
            agentId: address.agentId,
            commandId: address.commandId,
            command: envelope.command as RallarBlackBoxTestCommand,
            deadlineEpochMs
        }
    };
}

export function parseControlClientMessage(message: unknown): ParseControlClientMessageResult {
    const input = decodeControlEnvelopeRecord(message, 'Control client message');
    if (!input.ok) {
        return input;
    }
    const envelope = input.value;
    const { runId, agentId } = envelope;
    if (typeof runId !== 'string' || runId.length === 0) {
        return { ok: false, error: 'Control client message requires runId.' };
    }
    if (typeof agentId !== 'string' || agentId.length === 0) {
        return { ok: false, error: 'Control client message requires agentId.' };
    }
    const identity = { runId, agentId };
    switch (envelope.kind) {
        case 'register':
            return decodeRegisterEnvelope(envelope, identity);
        case 'heartbeat':
            return decodeHeartbeatEnvelope(envelope, identity);
        case 'result':
            return decodeResultEnvelope(envelope, identity);
        case 'event':
        case 'diagnostic':
        case 'stats':
        case 'report':
            return decodeEventEnvelope(envelope, { ...identity, kind: envelope.kind });
        default:
            return { ok: false, error: 'Unsupported control client message kind.' };
    }
}

export function toControlEventEnvelope(
    event: RallarBlackBoxTestEvent,
    runId: string,
    agentId: string
): ControlEventEnvelope {
    return {
        kind: toControlEventEnvelopeKind(event),
        protocolVersion: 1,
        runId,
        agentId,
        atEpochMs: event.atEpochMs,
        eventId: event.eventId,
        commandId: event.commandId,
        payload: event
    };
}

function toControlEventEnvelopeKind(event: RallarBlackBoxTestEvent): ControlEventEnvelope['kind'] {
    switch (event.kind) {
        case 'stats':
        case 'report':
        case 'diagnostic':
            return event.kind;
        default:
            return 'event';
    }
}

function decodeControlCommandAddress(
    envelope: ControlEnvelopeRecord,
    expected: ControlClientIdentity
): ControlCommandAddressResult {
    const { agentId, commandId } = envelope;
    if (envelope.kind !== 'command') {
        return { ok: false, error: 'Unsupported control message kind.' };
    }
    if (envelope.runId !== expected.runId) {
        return { ok: false, error: 'Control command runId does not match this agent.' };
    }
    if (agentId !== undefined && agentId !== expected.agentId) {
        return { ok: false, error: 'Control command agentId does not match this agent.' };
    }
    if (typeof commandId !== 'string' || commandId.length === 0) {
        return { ok: false, error: 'Control command requires commandId.' };
    }
    return { ok: true, agentId: agentId === undefined ? undefined : expected.agentId, commandId };
}

function decodeControlEnvelopeRecord(
    message: unknown,
    label: 'Control message' | 'Control client message'
): ControlEnvelopeRecordResult {
    let decoded: unknown;
    try {
        decoded = typeof message === 'string' ? JSON.parse(message) : message;
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!isJsonRecordValue(decoded)) {
        return { ok: false, error: `${label} must be an object.` };
    }
    if (decoded.protocolVersion !== RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION) {
        return { ok: false, error: 'Unsupported control protocol version.' };
    }
    return { ok: true, value: decoded };
}

function decodeRegisterEnvelope(
    envelope: ControlEnvelopeRecord,
    identity: ControlClientIdentity
): ParseControlClientMessageResult {
    const { atEpochMs, resume } = envelope;
    if (typeof atEpochMs !== 'number') {
        return { ok: false, error: 'Control register requires atEpochMs.' };
    }
    const completedCommandIds = isJsonRecordValue(resume) ? resume.completedCommandIds : undefined;
    if (!Array.isArray(completedCommandIds) || !completedCommandIds.every((id) => typeof id === 'string')) {
        return { ok: false, error: 'Control register requires resume.completedCommandIds.' };
    }
    const agentIdentity = decodeEnvelopeIdentity(envelope.identity);
    if (agentIdentity.left !== undefined) {
        return { ok: false, error: `Control register identity is invalid: ${agentIdentity.left}.` };
    }
    return {
        ok: true,
        envelope: {
            kind: 'register',
            protocolVersion: 1,
            ...identity,
            token: typeof envelope.token === 'string' ? envelope.token : undefined,
            atEpochMs,
            ...agentIdentity.right,
            resume: { completedCommandIds }
        }
    };
}

function decodeHeartbeatEnvelope(
    envelope: ControlEnvelopeRecord,
    identity: ControlClientIdentity
): ParseControlClientMessageResult {
    const { atEpochMs, status } = envelope;
    if (typeof atEpochMs !== 'number') {
        return { ok: false, error: 'Control heartbeat requires atEpochMs.' };
    }
    if (typeof status !== 'string') {
        return { ok: false, error: 'Control heartbeat requires status.' };
    }
    const agentIdentity = decodeEnvelopeIdentity(envelope.identity);
    if (agentIdentity.left !== undefined) {
        return { ok: false, error: `Control heartbeat identity is invalid: ${agentIdentity.left}.` };
    }
    return {
        ok: true,
        envelope: {
            kind: 'heartbeat',
            protocolVersion: 1,
            ...identity,
            atEpochMs,
            status,
            ...agentIdentity.right,
            lastCommandId: typeof envelope.lastCommandId === 'string' ? envelope.lastCommandId : undefined,
            lastEventAtEpochMs: typeof envelope.lastEventAtEpochMs === 'number'
                ? envelope.lastEventAtEpochMs
                : undefined
        }
    };
}

function decodeResultEnvelope(
    envelope: ControlEnvelopeRecord,
    identity: ControlClientIdentity
): ParseControlClientMessageResult {
    const { commandId, ok } = envelope;
    if (typeof commandId !== 'string' || commandId.length === 0) {
        return { ok: false, error: 'Control result requires commandId.' };
    }
    if (typeof ok !== 'boolean') {
        return { ok: false, error: 'Control result requires ok.' };
    }
    return {
        ok: true,
        envelope: {
            kind: 'result',
            protocolVersion: 1,
            ...identity,
            commandId,
            ok,
            result: envelope.result as RallarBlackBoxTestResult | undefined,
            error: envelope.error as ControlResultEnvelope['error'],
            replayed: typeof envelope.replayed === 'boolean' ? envelope.replayed : undefined
        }
    };
}

function decodeEventEnvelope(
    envelope: ControlEnvelopeRecord,
    address: ControlClientIdentity & Pick<ControlEventEnvelope, 'kind'>
): ParseControlClientMessageResult {
    const atEpochMs = envelope.atEpochMs;
    if (typeof atEpochMs !== 'number') {
        return { ok: false, error: 'Control event requires atEpochMs.' };
    }
    return {
        ok: true,
        envelope: {
            kind: address.kind,
            protocolVersion: 1,
            runId: address.runId,
            agentId: address.agentId,
            atEpochMs,
            eventId: typeof envelope.eventId === 'string' ? envelope.eventId : undefined,
            commandId: typeof envelope.commandId === 'string' ? envelope.commandId : undefined,
            payload: envelope.payload
        }
    };
}

/** An envelope that carries no identity leaves the agent's recorded identity unchanged. */
function decodeEnvelopeIdentity(value: unknown): Either<string, Pick<ControlRegisterEnvelope, 'identity'>> {
    return value === undefined
        ? Either.ofRight({})
        : decodeControlAgentIdentity(value).mapRight((identity) => ({ identity }));
}
