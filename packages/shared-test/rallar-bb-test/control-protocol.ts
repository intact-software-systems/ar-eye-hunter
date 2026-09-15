import {
    type RallarValidationIssue
} from '@shared/api/rallar-validation.ts';
import { validateRallarBlackBoxTestCommand } from './control/validate-rallar-black-box-test-command.ts';
import type { RallarBlackBoxControlAgentIdentity, RallarBlackBoxGeoLocation } from './distributed-run.ts';
import { parseControlAgentCapabilities } from './distributed/control-agent-capabilities.ts';
import { isJsonRecordValue } from './schema/json-schema-validation.ts';
import {
    type RallarBlackBoxTestCommand,
    type RallarBlackBoxTestEvent,
    type RallarBlackBoxTestResult
} from './rallar-black-box-test-contracts.ts';

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

export type ControlCommandValidationResult =
    | Readonly<{ ok: true; }>
    | Readonly<{ ok: false; error: string; issues?: readonly RallarValidationIssue[]; }>;

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
        ? value
        : undefined;
}

function parseControlAgentIdentity(value: unknown): RallarBlackBoxControlAgentIdentity | undefined {
    if (!isJsonRecordValue(value)) {
        return undefined;
    }

    const identity: RallarBlackBoxControlAgentIdentity = {
        principalId: optionalString(value.principalId),
        clientId: optionalString(value.clientId),
        username: optionalString(value.username),
        sessionId: optionalString(value.sessionId),
        clientInstanceId: optionalString(value.clientInstanceId),
        applicationId: optionalString(value.applicationId),
        workspaceId: optionalString(value.workspaceId),
        groupId: optionalString(value.groupId),
        providerMode: optionalString(value.providerMode),
        browserLabel: optionalString(value.browserLabel),
        sessionLabel: optionalString(value.sessionLabel),
        region: optionalString(value.region),
        provider: optionalString(value.provider),
        datacenter: optionalString(value.datacenter),
        hostId: optionalString(value.hostId),
        agentPoolId: optionalString(value.agentPoolId),
        deploymentId: optionalString(value.deploymentId),
        browserName: optionalString(value.browserName),
        browserVersion: optionalString(value.browserVersion),
        os: optionalString(value.os),
        tags: parseStringArray(value.tags),
        location: parseGeoLocation(value.location),
        capabilities: parseControlAgentCapabilities(value.capabilities),
        updatedAtEpochMs: typeof value.updatedAtEpochMs === 'number'
            ? value.updatedAtEpochMs
            : undefined
    };

    return Object.values(identity).some((entry) => entry !== undefined)
        ? identity
        : undefined;
}

function parseGeoLocation(value: unknown): RallarBlackBoxGeoLocation | undefined {
    if (!isJsonRecordValue(value)) {
        return undefined;
    }

    const latitude = typeof value.latitude === 'number' ? value.latitude : undefined;
    const longitude = typeof value.longitude === 'number' ? value.longitude : undefined;
    if (
        latitude === undefined ||
        longitude === undefined ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
    ) {
        return undefined;
    }

    return {
        latitude,
        longitude,
        label: optionalString(value.label),
        precision: value.precision === 'approximate' ? 'approximate' : 'exact'
    };
}

function parseStringArray(value: unknown): readonly string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const strings = value
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => entry.trim());
    return strings.length > 0 ? strings : undefined;
}

export function parseControlServerMessage(
    data: unknown,
    expected: Readonly<{
        runId: string;
        agentId: string;
    }>
): ParseControlMessageResult {
    const input = parseControlEnvelopeInput(data, 'Control message');
    if (!input.ok) {
        return input;
    }
    const parsed = input.value;
    if (parsed.kind !== 'command') {
        return { ok: false, error: 'Unsupported control message kind.' };
    }

    if (parsed.runId !== expected.runId) {
        return { ok: false, error: 'Control command runId does not match this agent.' };
    }

    if (
        parsed.agentId !== undefined &&
        parsed.agentId !== expected.agentId
    ) {
        return { ok: false, error: 'Control command agentId does not match this agent.' };
    }

    if (typeof parsed.commandId !== 'string' || parsed.commandId.length === 0) {
        return { ok: false, error: 'Control command requires commandId.' };
    }

    const commandValidation = validateRallarBlackBoxTestCommand(parsed.command);
    if (!commandValidation.ok) {
        return {
            ok: false,
            error: `Control command payload is invalid: ${commandValidation.error}`,
            issues: commandValidation.issues
        };
    }

    if (
        parsed.deadlineEpochMs !== undefined &&
        typeof parsed.deadlineEpochMs !== 'number'
    ) {
        return { ok: false, error: 'Control command deadlineEpochMs must be a number.' };
    }

    return {
        ok: true,
        envelope: {
            kind: 'command',
            protocolVersion: 1,
            runId: parsed.runId,
            agentId: parsed.agentId,
            commandId: parsed.commandId,
            command: parsed.command as RallarBlackBoxTestCommand,
            deadlineEpochMs: parsed.deadlineEpochMs
        }
    };
}

export function parseControlClientMessage(data: unknown): ParseControlClientMessageResult {
    const input = parseControlEnvelopeInput(data, 'Control client message');
    if (!input.ok) {
        return input;
    }
    const parsed = input.value;
    if (typeof parsed.runId !== 'string' || parsed.runId.length === 0) {
        return { ok: false, error: 'Control client message requires runId.' };
    }
    if (typeof parsed.agentId !== 'string' || parsed.agentId.length === 0) {
        return { ok: false, error: 'Control client message requires agentId.' };
    }
    const identity = { runId: parsed.runId, agentId: parsed.agentId };
    switch (parsed.kind) {
        case 'register':
            return parseRegisterEnvelope(parsed, identity);
        case 'heartbeat':
            return parseHeartbeatEnvelope(parsed, identity);
        case 'result':
            return parseResultEnvelope(parsed, identity);
        case 'event':
        case 'diagnostic':
        case 'stats':
        case 'report':
            return parseEventEnvelope(parsed, identity, parsed.kind);
        default:
            return { ok: false, error: 'Unsupported control client message kind.' };
    }
}

export function toControlEventEnvelope(
    event: RallarBlackBoxTestEvent,
    runId: string,
    agentId: string
): ControlEventEnvelope {
    const kind = event.kind === 'stats'
        ? 'stats'
        : event.kind === 'report'
        ? 'report'
        : event.kind === 'diagnostic'
        ? 'diagnostic'
        : 'event';

    return {
        kind,
        protocolVersion: 1,
        runId,
        agentId,
        atEpochMs: event.atEpochMs,
        eventId: event.eventId,
        commandId: event.commandId,
        payload: event
    };
}

export { validateRallarBlackBoxTestCommand } from './control/validate-rallar-black-box-test-command.ts';

function parseRegisterEnvelope(
    parsed: Record<string, unknown>,
    identity: ControlClientIdentity
): ParseControlClientMessageResult {
    if (typeof parsed.atEpochMs !== 'number') {
        return { ok: false, error: 'Control register requires atEpochMs.' };
    }
    if (
        !isJsonRecordValue(parsed.resume) ||
        !Array.isArray(parsed.resume.completedCommandIds) ||
        !parsed.resume.completedCommandIds.every((id) => typeof id === 'string')
    ) {
        return {
            ok: false,
            error: 'Control register requires resume.completedCommandIds.'
        };
    }
    return {
        ok: true,
        envelope: {
            kind: 'register',
            protocolVersion: 1,
            runId: identity.runId,
            agentId: identity.agentId,
            token: typeof parsed.token === 'string' ? parsed.token : undefined,
            atEpochMs: parsed.atEpochMs,
            identity: parseControlAgentIdentity(parsed.identity),
            resume: {
                completedCommandIds: parsed.resume.completedCommandIds
            }
        }
    };
}

function parseHeartbeatEnvelope(
    parsed: Record<string, unknown>,
    identity: ControlClientIdentity
): ParseControlClientMessageResult {
    if (typeof parsed.atEpochMs !== 'number') {
        return { ok: false, error: 'Control heartbeat requires atEpochMs.' };
    }
    if (typeof parsed.status !== 'string') {
        return { ok: false, error: 'Control heartbeat requires status.' };
    }
    return {
        ok: true,
        envelope: {
            kind: 'heartbeat',
            protocolVersion: 1,
            runId: identity.runId,
            agentId: identity.agentId,
            atEpochMs: parsed.atEpochMs,
            status: parsed.status,
            identity: parseControlAgentIdentity(parsed.identity),
            lastCommandId: typeof parsed.lastCommandId === 'string'
                ? parsed.lastCommandId
                : undefined,
            lastEventAtEpochMs: typeof parsed.lastEventAtEpochMs === 'number'
                ? parsed.lastEventAtEpochMs
                : undefined
        }
    };
}

function parseResultEnvelope(
    parsed: Record<string, unknown>,
    identity: ControlClientIdentity
): ParseControlClientMessageResult {
    if (typeof parsed.commandId !== 'string' || parsed.commandId.length === 0) {
        return { ok: false, error: 'Control result requires commandId.' };
    }
    if (typeof parsed.ok !== 'boolean') {
        return { ok: false, error: 'Control result requires ok.' };
    }
    return {
        ok: true,
        envelope: {
            kind: 'result',
            protocolVersion: 1,
            runId: identity.runId,
            agentId: identity.agentId,
            commandId: parsed.commandId,
            ok: parsed.ok,
            result: parsed.result as RallarBlackBoxTestResult | undefined,
            error: parsed.error as ControlResultEnvelope['error'],
            replayed: typeof parsed.replayed === 'boolean' ? parsed.replayed : undefined
        }
    };
}

function parseEventEnvelope(
    parsed: Record<string, unknown>,
    identity: ControlClientIdentity,
    kind: 'event' | 'diagnostic' | 'stats' | 'report'
): ParseControlClientMessageResult {
    if (typeof parsed.atEpochMs !== 'number') {
        return { ok: false, error: 'Control event requires atEpochMs.' };
    }
    return {
        ok: true,
        envelope: {
            kind,
            protocolVersion: 1,
            runId: identity.runId,
            agentId: identity.agentId,
            atEpochMs: parsed.atEpochMs,
            eventId: typeof parsed.eventId === 'string' ? parsed.eventId : undefined,
            commandId: typeof parsed.commandId === 'string' ? parsed.commandId : undefined,
            payload: parsed.payload
        }
    };
}

interface ControlClientIdentity {
    readonly runId: string;
    readonly agentId: string;
}

type ControlEnvelopeInputResult = { readonly ok: true; readonly value: Record<string, unknown>; } | {
    readonly ok: false;
    readonly error: string;
};

function parseControlEnvelopeInput(
    data: unknown,
    label: 'Control message' | 'Control client message'
): ControlEnvelopeInputResult {
    let parsed: unknown;
    try {
        parsed = typeof data === 'string' ? JSON.parse(data) : data;
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!isJsonRecordValue(parsed)) {
        return { ok: false, error: label + ' must be an object.' };
    }
    if (parsed.protocolVersion !== RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION) {
        return { ok: false, error: 'Unsupported control protocol version.' };
    }
    return { ok: true, value: parsed };
}
