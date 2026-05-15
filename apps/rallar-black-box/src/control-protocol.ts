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
    token?: string;
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

export type ControlCommandValidationResult =
    | Readonly<{ ok: true }>
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

function unknownKeys(
    value: Record<string, unknown>,
    allowed: readonly string[],
): string[] {
    return Object.keys(value)
        .filter(key => !allowed.includes(key));
}

function fail(message: string): ControlCommandValidationResult {
    return {
        ok: false,
        error: message,
    };
}

function validateKeys(
    value: Record<string, unknown>,
    allowed: readonly string[],
    path: string,
): ControlCommandValidationResult {
    const unexpected = unknownKeys(value, allowed);
    return unexpected.length === 0
        ? { ok: true }
        : fail(`${path} has unsupported field: ${unexpected[0]}.`);
}

function validateStringField(
    value: Record<string, unknown>,
    key: string,
    path: string,
    required = false,
): ControlCommandValidationResult {
    if (value[key] === undefined) {
        return required ? fail(`${path}.${key} is required.`) : { ok: true };
    }

    return typeof value[key] === 'string'
        ? { ok: true }
        : fail(`${path}.${key} must be a string.`);
}

function validateNumberField(
    value: Record<string, unknown>,
    key: string,
    path: string,
): ControlCommandValidationResult {
    return value[key] === undefined || typeof value[key] === 'number'
        ? { ok: true }
        : fail(`${path}.${key} must be a number.`);
}

function validateObjectField(
    value: Record<string, unknown>,
    key: string,
    path: string,
    required = false,
): ControlCommandValidationResult {
    if (value[key] === undefined) {
        return required ? fail(`${path}.${key} is required.`) : { ok: true };
    }

    return isRecord(value[key])
        ? { ok: true }
        : fail(`${path}.${key} must be an object.`);
}

function validateHeaders(value: unknown, path: string): ControlCommandValidationResult {
    if (value === undefined) {
        return { ok: true };
    }
    if (!isRecord(value)) {
        return fail(`${path} must be an object.`);
    }
    const invalid = Object.entries(value)
        .find(([key, headerValue]) => typeof key !== 'string' || typeof headerValue !== 'string');
    return invalid
        ? fail(`${path}.${invalid[0]} must be a string.`)
        : { ok: true };
}

function validateBaseCommand(command: Record<string, unknown>): ControlCommandValidationResult {
    for (const field of ['commandId', 'label']) {
        const result = validateStringField(command, field, 'command');
        if (!result.ok) {
            return result;
        }
    }
    for (const field of ['deadlineEpochMs', 'timeoutMs']) {
        const result = validateNumberField(command, field, 'command');
        if (!result.ok) {
            return result;
        }
    }
    return validateObjectField(command, 'metadata', 'command');
}

function validateRecipe(value: unknown, path: string): ControlCommandValidationResult {
    if (!isRecord(value)) {
        return fail(`${path} must be an object.`);
    }

    let result = validateKeys(value, [
        'recipeId',
        'name',
        'description',
        'continueOnFailure',
        'commands',
        'metadata',
    ], path);
    if (!result.ok) {
        return result;
    }
    result = validateStringField(value, 'recipeId', path, true);
    if (!result.ok) {
        return result;
    }
    if (!Array.isArray(value.commands)) {
        return fail(`${path}.commands must be an array.`);
    }
    for (const [index, command] of value.commands.entries()) {
        result = validateRallarBlackBoxTestCommand(command);
        if (!result.ok) {
            return fail(`${path}.commands[${index}]: ${result.error}`);
        }
    }
    return { ok: true };
}

function validateHttpCommand(command: Record<string, unknown>): ControlCommandValidationResult {
    const request = command.request;
    if (!isRecord(request)) {
        return fail('http.request.request is required.');
    }

    let result = validateKeys(request, [
        'url',
        'path',
        'method',
        'headers',
        'body',
        'credentials',
        'mode',
    ], 'http.request.request');
    if (!result.ok) {
        return result;
    }
    if (request.url === undefined && request.path === undefined) {
        return fail('http.request.request requires url or path.');
    }
    for (const field of ['url', 'path', 'method', 'credentials', 'mode']) {
        result = validateStringField(request, field, 'http.request.request');
        if (!result.ok) {
            return result;
        }
    }
    result = validateHeaders(request.headers, 'http.request.request.headers');
    if (!result.ok) {
        return result;
    }

    if (command.response !== undefined) {
        if (!isRecord(command.response)) {
            return fail('http.request.response must be an object.');
        }
        result = validateKeys(command.response, ['body', 'maxBodyChars'], 'http.request.response');
        if (!result.ok) {
            return result;
        }
        if (
            command.response.body !== undefined &&
            command.response.body !== 'none' &&
            command.response.body !== 'text' &&
            command.response.body !== 'json'
        ) {
            return fail('http.request.response.body must be none, text, or json.');
        }
        result = validateNumberField(command.response, 'maxBodyChars', 'http.request.response');
        if (!result.ok) {
            return result;
        }
    }
    return { ok: true };
}

function validateWsCommand(command: Record<string, unknown>): ControlCommandValidationResult {
    let result = validateStringField(command, 'connection', 'ws');
    if (!result.ok) {
        return result;
    }

    if (command.kind === 'ws.open') {
        result = validateStringField(command, 'url', 'ws.open');
        if (!result.ok) {
            return result;
        }
        if (
            command.protocols !== undefined &&
            typeof command.protocols !== 'string' &&
            (!Array.isArray(command.protocols) ||
                !command.protocols.every(protocol => typeof protocol === 'string'))
        ) {
            return fail('ws.open.protocols must be a string or string array.');
        }
        return validateHeaders(command.headers, 'ws.open.headers');
    }

    if (command.kind === 'ws.close') {
        result = validateNumberField(command, 'code', 'ws.close');
        if (!result.ok) {
            return result;
        }
        return validateStringField(command, 'reason', 'ws.close');
    }

    return { ok: true };
}

function validateRtcCommand(command: Record<string, unknown>): ControlCommandValidationResult {
    for (const field of ['connection', 'actor', 'roomId']) {
        const result = validateStringField(command, field, 'rtc');
        if (!result.ok) {
            return result;
        }
    }
    if (
        command.transport !== undefined &&
        command.transport !== 'realtime' &&
        command.transport !== 'messages.rtc'
    ) {
        return fail('rtc.transport must be realtime or messages.rtc.');
    }
    return validateObjectField(command, 'rallar', 'rtc');
}

export function validateRallarBlackBoxTestCommand(
    value: unknown,
): ControlCommandValidationResult {
    if (!isCommand(value)) {
        return fail('Command must be an object with a supported kind.');
    }

    const command = value as Record<string, unknown>;
    let result = validateBaseCommand(command);
    if (!result.ok) {
        return result;
    }

    const base = ['kind', 'commandId', 'label', 'deadlineEpochMs', 'timeoutMs', 'metadata'];
    switch (value.kind) {
        case 'configure':
            result = validateKeys(command, [...base, 'config'], 'configure');
            return !result.ok ? result : validateObjectField(command, 'config', 'configure', true);
        case 'recipe.load':
            result = validateKeys(command, [...base, 'recipe'], 'recipe.load');
            return !result.ok ? result : validateRecipe(command.recipe, 'recipe.load.recipe');
        case 'recipe.run':
            result = validateKeys(command, [...base, 'recipe'], 'recipe.run');
            if (!result.ok || command.recipe === undefined) {
                return result;
            }
            return validateRecipe(command.recipe, 'recipe.run.recipe');
        case 'recipe.cancel':
            result = validateKeys(command, [...base, 'reason'], 'recipe.cancel');
            return !result.ok ? result : validateStringField(command, 'reason', 'recipe.cancel');
        case 'rtc.connect':
            result = validateKeys(command, [...base, 'connection', 'actor', 'roomId', 'transport', 'rallar'], 'rtc.connect');
            return !result.ok ? result : validateRtcCommand(command);
        case 'rtc.send':
            result = validateKeys(command, [...base, 'connection', 'send', 'expect', 'transport'], 'rtc.send');
            return !result.ok ? result : validateRtcCommand(command);
        case 'ws.open':
            result = validateKeys(command, [...base, 'connection', 'url', 'protocols', 'headers'], 'ws.open');
            return !result.ok ? result : validateWsCommand(command);
        case 'ws.send':
            result = validateKeys(command, [...base, 'connection', 'data'], 'ws.send');
            return !result.ok ? result : validateWsCommand(command);
        case 'ws.close':
            result = validateKeys(command, [...base, 'connection', 'code', 'reason'], 'ws.close');
            return !result.ok ? result : validateWsCommand(command);
        case 'http.request':
            result = validateKeys(command, [...base, 'request', 'response'], 'http.request');
            return !result.ok ? result : validateHttpCommand(command);
        case 'health':
        case 'stats':
        case 'close':
        case 'reset':
            return validateKeys(command, base, value.kind);
        default:
            return fail('Command kind is not supported.');
    }
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

    const commandValidation = validateRallarBlackBoxTestCommand(parsed.command);
    if (!commandValidation.ok) {
        return {
            ok: false,
            error: `Control command payload is invalid: ${commandValidation.error}`,
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
                    token: typeof parsed.token === 'string' ? parsed.token : undefined,
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
