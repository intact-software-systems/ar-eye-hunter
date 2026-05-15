import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandKind,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestResult,
} from '@shared-test/rallar-bb-test/types.ts';

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
    atEpochMs: number;
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

export type ControlServerEnvelope = ControlCommandEnvelope;

export type ParseControlMessageResult =
    | Readonly<{ ok: true; envelope: ControlServerEnvelope }>
    | Readonly<{ ok: false; error: string }>;

export type ParseControlClientMessageResult =
    | Readonly<{ ok: true; envelope: ControlClientEnvelope }>
    | Readonly<{ ok: false; error: string }>;

const COMMAND_KINDS: readonly RallarBlackBoxTestCommandKind[] = [
    'configure',
    'recipe.load',
    'recipe.run',
    'recipe.cancel',
    'rtc.connect',
    'rtc.send',
    'ws.open',
    'ws.send',
    'ws.close',
    'http.request',
    'health',
    'stats',
    'close',
    'reset',
];

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCommandKind(value: unknown): value is RallarBlackBoxTestCommandKind {
    return typeof value === 'string' &&
        COMMAND_KINDS.includes(value as RallarBlackBoxTestCommandKind);
}

function isCommand(value: unknown): value is RallarBlackBoxTestCommand {
    return isRecord(value) && isCommandKind(value.kind);
}

export function parseControlServerMessage(
    data: unknown,
    expected: Readonly<{
        runId: string;
        agentId: string;
    }>,
): ParseControlMessageResult {
    let parsed: unknown;
    try {
        parsed = typeof data === 'string' ? JSON.parse(data) : data;
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }

    if (!isRecord(parsed)) {
        return { ok: false, error: 'Control message must be an object.' };
    }

    if (parsed.protocolVersion !== RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION) {
        return { ok: false, error: 'Unsupported control protocol version.' };
    }

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

    if (!isCommand(parsed.command)) {
        return { ok: false, error: 'Control command payload is invalid.' };
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
            command: parsed.command,
            deadlineEpochMs: parsed.deadlineEpochMs,
        },
    };
}

export function parseControlClientMessage(data: unknown): ParseControlClientMessageResult {
    let parsed: unknown;
    try {
        parsed = typeof data === 'string' ? JSON.parse(data) : data;
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }

    if (!isRecord(parsed)) {
        return { ok: false, error: 'Control client message must be an object.' };
    }

    if (parsed.protocolVersion !== RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION) {
        return { ok: false, error: 'Unsupported control protocol version.' };
    }

    if (typeof parsed.runId !== 'string' || parsed.runId.length === 0) {
        return { ok: false, error: 'Control client message requires runId.' };
    }

    if (typeof parsed.agentId !== 'string' || parsed.agentId.length === 0) {
        return { ok: false, error: 'Control client message requires agentId.' };
    }

    switch (parsed.kind) {
        case 'register':
            if (typeof parsed.atEpochMs !== 'number') {
                return { ok: false, error: 'Control register requires atEpochMs.' };
            }
            if (
                !isRecord(parsed.resume) ||
                !Array.isArray(parsed.resume.completedCommandIds) ||
                !parsed.resume.completedCommandIds.every((id) => typeof id === 'string')
            ) {
                return {
                    ok: false,
                    error: 'Control register requires resume.completedCommandIds.',
                };
            }
            return {
                ok: true,
                envelope: {
                    kind: 'register',
                    protocolVersion: 1,
                    runId: parsed.runId,
                    agentId: parsed.agentId,
                    atEpochMs: parsed.atEpochMs,
                    resume: {
                        completedCommandIds: parsed.resume.completedCommandIds,
                    },
                },
            };
        case 'heartbeat':
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
                    runId: parsed.runId,
                    agentId: parsed.agentId,
                    atEpochMs: parsed.atEpochMs,
                    status: parsed.status,
                    lastCommandId: typeof parsed.lastCommandId === 'string'
                        ? parsed.lastCommandId
                        : undefined,
                    lastEventAtEpochMs: typeof parsed.lastEventAtEpochMs === 'number'
                        ? parsed.lastEventAtEpochMs
                        : undefined,
                },
            };
        case 'result':
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
                    runId: parsed.runId,
                    agentId: parsed.agentId,
                    commandId: parsed.commandId,
                    ok: parsed.ok,
                    result: parsed.result as RallarBlackBoxTestResult | undefined,
                    error: parsed.error as ControlResultEnvelope['error'],
                    replayed: typeof parsed.replayed === 'boolean' ? parsed.replayed : undefined,
                },
            };
        case 'event':
        case 'diagnostic':
        case 'stats':
        case 'report':
            if (typeof parsed.atEpochMs !== 'number') {
                return { ok: false, error: 'Control event requires atEpochMs.' };
            }
            return {
                ok: true,
                envelope: {
                    kind: parsed.kind,
                    protocolVersion: 1,
                    runId: parsed.runId,
                    agentId: parsed.agentId,
                    atEpochMs: parsed.atEpochMs,
                    eventId: typeof parsed.eventId === 'string' ? parsed.eventId : undefined,
                    commandId: typeof parsed.commandId === 'string' ? parsed.commandId : undefined,
                    payload: parsed.payload,
                },
            };
        default:
            return { ok: false, error: 'Unsupported control client message kind.' };
    }
}

export function toControlEventEnvelope(
    event: RallarBlackBoxTestEvent,
    runId: string,
    agentId: string,
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
        payload: event,
    };
}
