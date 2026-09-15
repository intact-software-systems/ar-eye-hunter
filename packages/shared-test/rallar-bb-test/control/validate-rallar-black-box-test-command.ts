import {
    formatRallarValidation,
    validateRallarRouteId,
    type RallarValidationResult
} from '@shared/api/rallar-validation.ts';
import { validateAlmControlCommand } from '../alm/control-protocol-alm-commands.ts';
import type { ControlCommandValidationResult } from '../control-protocol.ts';
import { RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA } from '../schema.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import {
    RALLAR_BLACK_BOX_TEST_COMMAND_KINDS,
    RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS,
    type RallarBlackBoxTestCommand,
    type RallarBlackBoxTestCommandKind
} from '../rallar-black-box-test-contracts.ts';
function isCommandKind(value: unknown): value is RallarBlackBoxTestCommandKind {
    return typeof value === 'string' &&
        RALLAR_BLACK_BOX_TEST_COMMAND_KINDS.includes(value as RallarBlackBoxTestCommandKind);
}

function isCommand(value: unknown): value is RallarBlackBoxTestCommand {
    return isJsonRecordValue(value) && isCommandKind(value.kind);
}

function unknownKeys(
    value: Record<string, unknown>,
    allowed: readonly string[]
): string[] {
    return Object.keys(value)
        .filter((key) => !allowed.includes(key));
}

function fail(message: string): ControlCommandValidationResult {
    return {
        ok: false,
        error: message
    };
}

function failRallarValidation(
    validation: RallarValidationResult
): ControlCommandValidationResult {
    return {
        ok: false,
        error: formatRallarValidation(validation),
        issues: validation.issues
    };
}

function validateKeys(
    value: Record<string, unknown>,
    allowed: readonly string[],
    path: string
): ControlCommandValidationResult {
    const unexpected = unknownKeys(value, allowed);
    return unexpected.length === 0
        ? { ok: true }
        : fail(`${path} has unsupported field: ${unexpected[0]}.`);
}

function validateStringField(input: ValidateStringFieldInput): ControlCommandValidationResult {
    const { value, key, path, required } = input;
    if (value[key] === undefined) {
        return required ? fail(`${path}.${key} is required.`) : { ok: true };
    }

    return typeof value[key] === 'string'
        ? { ok: true }
        : fail(`${path}.${key} must be a string.`);
}

function validateRouteIdField(input: ValidateRouteIdFieldInput): ControlCommandValidationResult {
    const { value, key, path, label } = input;
    if (value[key] === undefined) {
        return { ok: true };
    }
    if (typeof value[key] !== 'string') {
        return fail(`${path}.${key} must be a string.`);
    }

    const validation = validateRallarRouteId(value[key], `${path}.${key}`, label);
    return validation.ok ? { ok: true } : failRallarValidation(validation);
}

function validateNumberField(
    value: Record<string, unknown>,
    key: string,
    path: string
): ControlCommandValidationResult {
    if (value[key] === undefined) {
        return { ok: true };
    }
    if (typeof value[key] !== 'number') {
        return fail(`${path}.${key} must be a number.`);
    }
    return Number.isFinite(value[key])
        ? { ok: true }
        : fail(`${path}.${key} must be a finite number.`);
}

function validatePositiveNumberField(
    value: Record<string, unknown>,
    key: string,
    path: string
): ControlCommandValidationResult {
    const result = validateNumberField(value, key, path);
    if (!result.ok || value[key] === undefined) {
        return result;
    }

    return (value[key] as number) > 0
        ? { ok: true }
        : fail(`${path}.${key} must be > 0.`);
}

function validateIntegerField(input: ValidateIntegerFieldInput): ControlCommandValidationResult {
    const { value, key, path, options } = input;
    if (value[key] === undefined) {
        return { ok: true };
    }
    if (!Number.isInteger(value[key])) {
        return fail(`${path}.${key} must be an integer.`);
    }
    if (options.minimum !== undefined && (value[key] as number) < options.minimum) {
        return fail(`${path}.${key} must be >= ${options.minimum}.`);
    }
    if (options.maximum !== undefined && (value[key] as number) > options.maximum) {
        return fail(`${path}.${key} must be <= ${options.maximum}.`);
    }
    return { ok: true };
}

function validateBooleanField(
    value: Record<string, unknown>,
    key: string,
    path: string
): ControlCommandValidationResult {
    return value[key] === undefined || typeof value[key] === 'boolean'
        ? { ok: true }
        : fail(`${path}.${key} must be a boolean.`);
}

function validateEnumField(input: ValidateEnumFieldInput): ControlCommandValidationResult {
    const { value, key, path, allowed } = input;
    if (value[key] === undefined) {
        return { ok: true };
    }

    return typeof value[key] === 'string' && allowed.includes(value[key])
        ? { ok: true }
        : fail(`${path}.${key} must be one of ${allowed.join(', ')}.`);
}

function validateObjectField(input: ValidateObjectFieldInput): ControlCommandValidationResult {
    const { value, key, path, required } = input;
    if (value[key] === undefined) {
        return required ? fail(`${path}.${key} is required.`) : { ok: true };
    }

    return isJsonRecordValue(value[key])
        ? { ok: true }
        : fail(`${path}.${key} must be an object.`);
}

function validateHeaders(value: unknown, path: string): ControlCommandValidationResult {
    if (value === undefined) {
        return { ok: true };
    }
    if (!isJsonRecordValue(value)) {
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
        const result = validateStringField({ value: command, key: field, path: 'command', required: false });
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
    return validateObjectField({ value: command, key: 'metadata', path: 'command', required: false });
}

function validateRecipe(value: unknown, path: string, depth = 0): ControlCommandValidationResult {
    if (!isJsonRecordValue(value)) {
        return fail(`${path} must be an object.`);
    }

    let result = validateKeys(value, [
        'schemaVersion',
        'recipeId',
        'name',
        'description',
        'continueOnFailure',
        'commands',
        'metadata'
    ], path);
    if (!result.ok) {
        return result;
    }
    if (value.schemaVersion !== 1) {
        return fail(`${path}.schemaVersion must be 1.`);
    }
    result = validateStringField({ value: value, key: 'recipeId', path: path, required: true });
    if (!result.ok) {
        return result;
    }
    if (!Array.isArray(value.commands)) {
        return fail(`${path}.commands must be an array.`);
    }
    for (const [index, command] of value.commands.entries()) {
        result = validateRallarBlackBoxTestCommand(command, depth);
        if (!result.ok) {
            return fail(`${path}.commands[${index}]: ${result.error}`);
        }
    }
    return { ok: true };
}

function validateCompositeChildCommands(
    commands: unknown,
    path: string,
    depth: number
): ControlCommandValidationResult {
    if (depth > RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxDepth) {
        return fail(`${path} exceeds max composite depth ${RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxDepth}.`);
    }
    if (!Array.isArray(commands)) {
        return fail(`${path} must be an array.`);
    }
    if (commands.length === 0) {
        return fail(`${path} requires at least one command.`);
    }
    for (const [index, child] of commands.entries()) {
        const result = validateRallarBlackBoxTestCommand(child, depth + 1);
        if (!result.ok) {
            return fail(`${path}[${index}]: ${result.error}`);
        }
    }
    return { ok: true };
}

function validateLoopCommand(
    command: Record<string, unknown>,
    depth: number
): ControlCommandValidationResult {
    let result = validateCompositeChildCommands(command.commands, 'loop.commands', depth);
    if (!result.ok) {
        return result;
    }
    result = validateCompositeCountAndDuration(command, 'loop');
    if (!result.ok) {
        return result;
    }
    for (const field of ['intervalMs', 'delayMs']) {
        result = validateIntegerField({ value: command, key: field, path: 'loop', options: { minimum: 0 } });
        if (!result.ok) {
            return result;
        }
    }
    result = validateIntegerField({
        value: command,
        key: 'maxCommands',
        path: 'loop',
        options: {
            minimum: 1,
            maximum: RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands
        }
    });
    if (!result.ok) {
        return result;
    }
    result = validateBooleanField(command, 'continueOnFailure', 'loop');
    if (!result.ok) {
        return result;
    }
    result = validateEnumField({ value: command, key: 'until', path: 'loop', allowed: ['first-success'] });
    if (!result.ok) {
        return result;
    }
    result = validatePositiveNumberField(command, 'backoffMultiplier', 'loop');
    if (!result.ok) {
        return result;
    }
    if (command.backoffMultiplier !== undefined && (command.backoffMultiplier as number) < 1) {
        return fail('loop.backoffMultiplier must be >= 1.');
    }
    if (command.backoffMultiplier !== undefined && command.until === undefined) {
        return fail('loop.backoffMultiplier requires until mode.');
    }
    if (command.until !== undefined && command.continueOnFailure === true) {
        return fail('loop.continueOnFailure contradicts until mode.');
    }
    return validateLoopThresholds(command.thresholds);
}

function validateLoopThresholds(value: unknown): ControlCommandValidationResult {
    if (value === undefined) {
        return { ok: true };
    }
    if (!isJsonRecordValue(value)) {
        return fail('loop.thresholds must be an object.');
    }
    let result = validateKeys(value, [
        'minAchievedRateHz',
        'maxAverageStartDriftMs',
        'maxStartDriftMs',
        'maxJitterMs',
        'minSendSuccessRatio',
        'failOnBackpressure'
    ], 'loop.thresholds');
    if (!result.ok) {
        return result;
    }
    for (
        const field of [
            'minAchievedRateHz',
            'maxAverageStartDriftMs',
            'maxStartDriftMs',
            'maxJitterMs'
        ]
    ) {
        result = validateNumberField(value, field, 'loop.thresholds');
        if (!result.ok) {
            return result;
        }
        if (value[field] !== undefined && (value[field] as number) < 0) {
            return fail(`loop.thresholds.${field} must be >= 0.`);
        }
    }
    result = validateNumberField(value, 'minSendSuccessRatio', 'loop.thresholds');
    if (!result.ok) {
        return result;
    }
    if (
        value.minSendSuccessRatio !== undefined &&
        ((value.minSendSuccessRatio as number) < 0 || (value.minSendSuccessRatio as number) > 1)
    ) {
        return fail('loop.thresholds.minSendSuccessRatio must be between 0 and 1.');
    }
    return validateBooleanField(value, 'failOnBackpressure', 'loop.thresholds');
}

function validateParallelCommand(
    command: Record<string, unknown>,
    depth: number
): ControlCommandValidationResult {
    if (!Array.isArray(command.groups)) {
        return fail('parallel.groups must be an array.');
    }
    if (command.groups.length === 0) {
        return fail('parallel.groups requires at least one group.');
    }
    let result = validateIntegerField({
        value: command,
        key: 'maxConcurrency',
        path: 'parallel',
        options: {
            minimum: 1,
            maximum: RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxParallelConcurrency
        }
    });
    if (!result.ok) {
        return result;
    }
    for (const field of ['failFast', 'continueOnFailure']) {
        result = validateBooleanField(command, field, 'parallel');
        if (!result.ok) {
            return result;
        }
    }
    for (const [index, group] of command.groups.entries()) {
        const path = `parallel.groups[${index}]`;
        if (!isJsonRecordValue(group)) {
            return fail(`${path} must be an object.`);
        }
        result = validateKeys(group, ['groupId', 'label', 'commands', 'metadata'], path);
        if (!result.ok) {
            return result;
        }
        for (const field of ['groupId', 'label']) {
            result = validateStringField({ value: group, key: field, path: path, required: false });
            if (!result.ok) {
                return result;
            }
        }
        result = validateObjectField({ value: group, key: 'metadata', path: path, required: false });
        if (!result.ok) {
            return result;
        }
        result = validateCompositeChildCommands(group.commands, `${path}.commands`, depth);
        if (!result.ok) {
            return result;
        }
    }
    return { ok: true };
}

function validateWaitCommand(command: Record<string, unknown>): ControlCommandValidationResult {
    if (!isJsonRecordValue(command.match)) {
        return fail('wait.match is required.');
    }
    if (command.absent !== undefined && command.absent !== true) {
        return fail('wait.absent must be true when present.');
    }

    let result = validateKeys(command.match, [
        'kind',
        'topic',
        'commandId',
        'connection',
        'transport',
        'severity',
        'payloadPath',
        'equals',
        'contains',
        'exists',
        'sinceEpochMs'
    ], 'wait.match');
    if (!result.ok) {
        return result;
    }

    return validateWaitMatchFields(command.match);
}

function validateAssertCommand(command: Record<string, unknown>): ControlCommandValidationResult {
    let result = validateStringField({ value: command, key: 'source', path: 'assert', required: true });
    if (!result.ok) {
        return result;
    }
    if (command.operator === undefined) {
        return fail('assert.operator is required.');
    }
    return validateEnumField({
        value: command,
        key: 'operator',
        path: 'assert',
        allowed: [
            'equals',
            'notEquals',
            'contains',
            'exists',
            'gte',
            'lte',
            'gt',
            'lt',
            'between',
            'length',
            'matches',
            'matchesShape',
            'matchesShapeComplete'
        ]
    });
}

function validateHttpCommand(command: Record<string, unknown>): ControlCommandValidationResult {
    const request = command.request;
    if (!isJsonRecordValue(request)) {
        return fail('http.request.request is required.');
    }

    let result = validateKeys(request, [
        'url',
        'path',
        'method',
        'headers',
        'body',
        'credentials',
        'mode'
    ], 'http.request.request');
    if (!result.ok) {
        return result;
    }
    if (request.url === undefined && request.path === undefined) {
        return fail('http.request.request requires url or path.');
    }
    for (const field of ['url', 'path', 'method', 'credentials', 'mode']) {
        result = validateStringField({ value: request, key: field, path: 'http.request.request', required: false });
        if (!result.ok) {
            return result;
        }
    }
    result = validateHeaders(request.headers, 'http.request.request.headers');
    if (!result.ok) {
        return result;
    }

    return validateHttpResponse(command.response);
}

function validateWsCommand(command: Record<string, unknown>): ControlCommandValidationResult {
    let result = validateStringField({ value: command, key: 'connection', path: 'ws', required: false });
    if (!result.ok) {
        return result;
    }

    if (command.kind === 'ws.open') {
        result = validateStringField({ value: command, key: 'url', path: 'ws.open', required: false });
        if (!result.ok) {
            return result;
        }
        if (
            command.protocols !== undefined &&
            typeof command.protocols !== 'string' &&
            (!Array.isArray(command.protocols) ||
                !command.protocols.every((protocol) => typeof protocol === 'string'))
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
        return validateStringField({ value: command, key: 'reason', path: 'ws.close', required: false });
    }

    return { ok: true };
}

function validateRtcCommand(command: Record<string, unknown>): ControlCommandValidationResult {
    for (const field of ['connection', 'actor', 'roomId', 'applicationId', 'workspaceId']) {
        const result = validateStringField({ value: command, key: field, path: 'rtc', required: false });
        if (!result.ok) {
            return result;
        }
    }
    for (
        const [field, label] of [
            ['roomId', 'Room ID'],
            ['applicationId', 'Application ID'],
            ['workspaceId', 'Workspace ID']
        ] as const
    ) {
        const result = validateRouteIdField({ value: command, key: field, path: 'rtc', label: label });
        if (!result.ok) {
            return result;
        }
    }
    for (const field of ['scope', 'roomRef']) {
        const result = validateObjectField({ value: command, key: field, path: 'rtc', required: false });
        if (!result.ok) {
            return result;
        }
    }
    const minSnapshotVersion = validateNumberField(command, 'minSnapshotVersion', 'rtc');
    if (!minSnapshotVersion.ok) {
        return minSnapshotVersion;
    }
    const transports = command.kind === 'rtc.connect'
        ? RTC_CONNECT_TRANSPORTS
        : RTC_SEND_TRANSPORTS;
    if (command.transport !== undefined && !transports.includes(String(command.transport))) {
        return fail(`rtc.transport must be ${transports.join(' or ')}.`);
    }
    if (command.kind === 'rtc.connect') {
        const readiness = validateRtcConnectReadiness(command.readiness);
        if (!readiness.ok) {
            return readiness;
        }
    }
    return validateObjectField({ value: command, key: 'rallar', path: 'rtc', required: false });
}

function validateRtcConnectReadiness(value: unknown): ControlCommandValidationResult {
    if (value === undefined) {
        return { ok: true };
    }
    if (!isJsonRecordValue(value)) {
        return fail('rtc.readiness must be an object.');
    }

    let result = validateKeys(value, ['minReadyPeers', 'timeoutMs', 'intervalMs'], 'rtc.readiness');
    if (!result.ok) {
        return result;
    }
    for (const field of ['minReadyPeers', 'timeoutMs', 'intervalMs']) {
        result = validateIntegerField({ value: value, key: field, path: 'rtc.readiness', options: { minimum: 1 } });
        if (!result.ok) {
            return result;
        }
    }
    return { ok: true };
}

function validateRtcStreamThresholds(value: unknown): ControlCommandValidationResult {
    if (value === undefined) {
        return { ok: true };
    }
    if (!isJsonRecordValue(value)) {
        return fail('rtc.stream.thresholds must be an object.');
    }

    let result = validateKeys(value, [
        'minSendSuccessRatio',
        'maxDroppedFrames',
        'maxBackpressureCount',
        'maxP95SendDurationMs',
        'maxP99SendDurationMs',
        'maxAverageStartDriftMs',
        'maxStartDriftMs',
        'maxJitterMs'
    ], 'rtc.stream.thresholds');
    if (!result.ok) {
        return result;
    }

    result = validateNumberField(value, 'minSendSuccessRatio', 'rtc.stream.thresholds');
    if (!result.ok) {
        return result;
    }
    if (
        value.minSendSuccessRatio !== undefined &&
        ((value.minSendSuccessRatio as number) < 0 || (value.minSendSuccessRatio as number) > 1)
    ) {
        return fail('rtc.stream.thresholds.minSendSuccessRatio must be between 0 and 1.');
    }

    for (
        const field of [
            'maxDroppedFrames',
            'maxBackpressureCount',
            'maxP95SendDurationMs',
            'maxP99SendDurationMs',
            'maxAverageStartDriftMs',
            'maxStartDriftMs',
            'maxJitterMs'
        ]
    ) {
        result = validateNumberField(value, field, 'rtc.stream.thresholds');
        if (!result.ok) {
            return result;
        }
        if (value[field] !== undefined && (value[field] as number) < 0) {
            return fail(`rtc.stream.thresholds.${field} must be >= 0.`);
        }
    }

    return { ok: true };
}

function validateRtcStreamCommand(command: Record<string, unknown>): ControlCommandValidationResult {
    if (command.send === undefined) {
        return fail('rtc.stream.send is required.');
    }
    if (command.count === undefined && command.durationMs === undefined) {
        return fail('rtc.stream requires count or durationMs.');
    }
    if (command.intervalMs === undefined && command.rateHz === undefined) {
        return fail('rtc.stream requires intervalMs or rateHz.');
    }

    let result = validateCompositeCountAndDuration(command, 'rtc.stream');
    if (!result.ok) {
        return result;
    }
    result = validateIntegerField({ value: command, key: 'intervalMs', path: 'rtc.stream', options: { minimum: 1 } });
    if (!result.ok) {
        return result;
    }
    result = validatePositiveNumberField(command, 'rateHz', 'rtc.stream');
    if (!result.ok) {
        return result;
    }
    result = validateIntegerField({ value: command, key: 'maxInFlight', path: 'rtc.stream', options: { minimum: 1 } });
    if (!result.ok) {
        return result;
    }
    result = validateIntegerField({
        value: command,
        key: 'drainTimeoutMs',
        path: 'rtc.stream',
        options: { minimum: 0 }
    });
    if (!result.ok) {
        return result;
    }
    result = validateIntegerField({
        value: command,
        key: 'progressEveryMs',
        path: 'rtc.stream',
        options: { minimum: 1 }
    });
    if (!result.ok) {
        return result;
    }
    result = validateIntegerField({ value: command, key: 'sampleEvery', path: 'rtc.stream', options: { minimum: 1 } });
    if (!result.ok) {
        return result;
    }
    result = validateBooleanField(command, 'continueOnSendFailure', 'rtc.stream');
    if (!result.ok) {
        return result;
    }
    return validateRtcStreamThresholds(command.thresholds);
}

function validateRoomFields(
    command: Record<string, unknown>,
    path: string
): ControlCommandValidationResult {
    for (const field of ['roomId', 'applicationId', 'workspaceId']) {
        const result = validateStringField({ value: command, key: field, path: path, required: false });
        if (!result.ok) {
            return result;
        }
    }
    for (
        const [field, label] of [
            ['roomId', 'Room ID'],
            ['applicationId', 'Application ID'],
            ['workspaceId', 'Workspace ID']
        ] as const
    ) {
        const result = validateRouteIdField({ value: command, key: field, path: path, label: label });
        if (!result.ok) {
            return result;
        }
    }
    for (const field of ['scope', 'roomRef']) {
        const result = validateObjectField({ value: command, key: field, path: path, required: false });
        if (!result.ok) {
            return result;
        }
    }
    return { ok: true };
}

function validateDirectorRelayStartCommand(
    command: Record<string, unknown>
): ControlCommandValidationResult {
    let result = validateRoomFields(command, 'director.relay.start');
    if (!result.ok) {
        return result;
    }

    for (
        const field of [
            'handle',
            'laneId',
            'topicId',
            'intentTypeId',
            'outputTypeId',
            'heartbeatTypeId',
            'snapshotTypeId',
            'syncRequestTypeId'
        ]
    ) {
        result = validateStringField({
            value: command,
            key: field,
            path: 'director.relay.start',
            required: field === 'handle' || field === 'intentTypeId' || field === 'outputTypeId'
        });
        if (!result.ok) {
            return result;
        }
    }

    for (const field of ['heartbeatIntervalMs', 'snapshotIntervalMs']) {
        result = validateIntegerField({
            value: command,
            key: field,
            path: 'director.relay.start',
            options: {
                minimum: 0
            }
        });
        if (!result.ok) {
            return result;
        }
    }
    return { ok: true };
}

function validateFormationRoomIdentity(
    command: Record<string, unknown>,
    path: string
): ControlCommandValidationResult {
    const result = validateRoomFields(command, path);
    if (!result.ok) {
        return result;
    }
    if (command.roomRef !== undefined) {
        return { ok: true };
    }
    if (typeof command.applicationId === 'string' && typeof command.roomId === 'string') {
        return { ok: true };
    }
    return fail(`${path} must name its room with roomRef, or with applicationId and roomId.`);
}

function validateFormationCommand(command: Record<string, unknown>): ControlCommandValidationResult {
    switch (command.kind) {
        case 'formation.command': {
            const room = validateFormationRoomIdentity(command, 'formation.command');
            if (!room.ok) {
                return room;
            }
            const name = validateStringField({
                value: command,
                key: 'command',
                path: 'formation.command',
                required: true
            });
            if (!name.ok) {
                return name;
            }
            if (!FORMATION_COMMAND_NAMES.includes(String(command.command))) {
                return fail(
                    `formation.command.command must be one of ${FORMATION_COMMAND_NAMES.join(', ')}.`
                );
            }
            if (command.layout !== undefined && command.command !== 'connect') {
                return fail(`formation.command ${String(command.command)} does not take layout.`);
            }
            if (command.landing !== undefined && command.command !== 'reconfigure') {
                return fail(`formation.command ${String(command.command)} does not take landing.`);
            }
            const layout = validateObjectField({
                value: command,
                key: 'layout',
                path: 'formation.command',
                required: false
            });
            if (!layout.ok) {
                return layout;
            }
            const landing = validateStringField({
                value: command,
                key: 'landing',
                path: 'formation.command',
                required: false
            });
            if (!landing.ok) {
                return landing;
            }
            return validateStringField({ value: command, key: 'reason', path: 'formation.command', required: false });
        }
        case 'formation.readiness':
            return validateFormationRoomIdentity(command, 'formation.readiness');
        default:
            return fail('Command kind is not supported.');
    }
}

function validateDirectorCommand(command: Record<string, unknown>): ControlCommandValidationResult {
    switch (command.kind) {
        case 'director.appoint': {
            const roomFields = validateRoomFields(command, 'director.appoint');
            if (!roomFields.ok) {
                return roomFields;
            }
            return validateIntegerField({
                value: command,
                key: 'heartbeatTtlMs',
                path: 'director.appoint',
                options: {
                    minimum: 1
                }
            });
        }
        case 'director.resign':
            return validateRoomFields(command, 'director.resign');
        case 'director.status': {
            let result = validateRoomFields(command, 'director.status');
            if (!result.ok) {
                return result;
            }
            result = validateBooleanField(command, 'refresh', 'director.status');
            if (!result.ok) {
                return result;
            }
            return validateNumberField(command, 'now', 'director.status');
        }
        case 'director.relay.start':
            return validateDirectorRelayStartCommand(command);
        case 'director.intent': {
            const handle = validateStringField({
                value: command,
                key: 'handle',
                path: 'director.intent',
                required: true
            });
            if (!handle.ok) {
                return handle;
            }
            return Object.prototype.hasOwnProperty.call(command, 'intent')
                ? { ok: true }
                : fail('director.intent.intent is required.');
        }
        case 'director.sync.request':
        case 'director.relay.stop':
            return validateStringField({ value: command, key: 'handle', path: String(command.kind), required: true });
        default:
            return fail('Director command kind is not supported.');
    }
}

export function validateRallarBlackBoxTestCommand(value: unknown, depth = 0): ControlCommandValidationResult {
    if (!isCommand(value)) {
        return fail('Command must be an object with a supported kind.');
    }
    if (depth > RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxDepth) {
        return fail('Command exceeds max composite depth ' + RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxDepth + '.');
    }
    const command = value as Record<string, unknown>;
    const base = validateBaseCommand(command);
    if (!base.ok) {
        return base;
    }
    const schema = RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA.oneOf?.find((schema) =>
        schema.properties?.kind?.const === value.kind
    );
    const keys = validateKeys(command, Object.keys(schema?.properties ?? {}), value.kind);
    if (!keys.ok) {
        return keys;
    }
    return validateRecursiveCommand(command, depth) ?? validateLeafCommand(value);
}

const RTC_CONNECT_TRANSPORTS = ['realtime', 'messages.rtc', 'messages.ws'];

const RTC_SEND_TRANSPORTS = ['realtime', 'messages.rtc'];

const FORMATION_COMMAND_NAMES = [
    'plan',
    'connect',
    'activate',
    'reconfigure',
    'pause',
    'resume',
    'reset',
    'start'
];

function validateRecursiveCommand(
    command: Record<string, unknown>,
    depth: number
): ControlCommandValidationResult | undefined {
    switch (command.kind) {
        case 'recipe.load':
            return validateRecipe(command.recipe, 'recipe.load.recipe', depth);
        case 'recipe.run':
            return command.recipe === undefined
                ? { ok: true }
                : validateRecipe(command.recipe, 'recipe.run.recipe', depth);
        case 'loop':
            return validateLoopCommand(command, depth);
        case 'parallel':
            return validateParallelCommand(command, depth);
        default:
            return undefined;
    }
}

function validateLeafCommand(value: RallarBlackBoxTestCommand): ControlCommandValidationResult {
    const command = value as Record<string, unknown>;
    switch (value.kind) {
        case 'configure':
            return validateObjectField({ value: command, key: 'config', path: 'configure', required: true });
        case 'recipe.cancel':
            return validateStringField({ value: command, key: 'reason', path: 'recipe.cancel', required: false });
        case 'wait':
            return validateWaitCommand(command);
        case 'assert':
            return validateAssertCommand(command);
        case 'rtc.connect':
        case 'rtc.send':
            return validateRtcCommand(command);
        case 'rtc.stream': {
            const result = validateRtcCommand(command);
            return result.ok ? validateRtcStreamCommand(command) : result;
        }
        case 'messages.send':
        case 'messages.observe':
        case 'messages.cancel':
        case 'messages.received':
        case 'messages.receipts':
        case 'fault.inject':
        case 'storage.counters':
        case 'agent.reload':
            return validateAlmControlCommand(command, value.kind);
        case 'ws.open':
        case 'ws.send':
        case 'ws.close':
            return validateWsCommand(command);
        case 'http.request':
            return validateHttpCommand(command);
        case 'formation.command':
        case 'formation.readiness':
            return validateFormationCommand(command);
        case 'director.appoint':
        case 'director.resign':
        case 'director.status':
        case 'director.relay.start':
        case 'director.intent':
        case 'director.sync.request':
        case 'director.relay.stop':
            return validateDirectorCommand(command);
        case 'health':
            return validateBooleanField(command, 'includeRtcDiagnostics', 'health');
        case 'stats':
        case 'close':
        case 'reset':
            return { ok: true };
        default:
            return fail('Command kind is not supported.');
    }
}

interface ValidateStringFieldInput {
    readonly value: Record<string, unknown>;
    readonly key: string;
    readonly path: string;
    readonly required: boolean;
}

interface ValidateRouteIdFieldInput {
    readonly value: Record<string, unknown>;
    readonly key: string;
    readonly path: string;
    readonly label: string;
}

interface ValidateIntegerFieldInput {
    readonly value: Record<string, unknown>;
    readonly key: string;
    readonly path: string;
    readonly options: Readonly<{ minimum?: number; maximum?: number; }>;
}

interface ValidateEnumFieldInput {
    readonly value: Record<string, unknown>;
    readonly key: string;
    readonly path: string;
    readonly allowed: readonly string[];
}

interface ValidateObjectFieldInput {
    readonly value: Record<string, unknown>;
    readonly key: string;
    readonly path: string;
    readonly required: boolean;
}

function validateCompositeCountAndDuration(
    command: Record<string, unknown>,
    path: 'loop' | 'rtc.stream'
): ControlCommandValidationResult {
    const count = validateIntegerField({
        value: command,
        key: 'count',
        path,
        options: { minimum: 1, maximum: RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopCount }
    });
    return count.ok
        ? validateIntegerField({
            value: command,
            key: 'durationMs',
            path,
            options: { minimum: 1, maximum: RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxLoopDurationMs }
        })
        : count;
}

function validateWaitMatchFields(match: Record<string, unknown>): ControlCommandValidationResult {
    let result = validateEnumField({
        value: match,
        key: 'kind',
        path: 'wait.match',
        allowed: ['event', 'diagnostic', 'message', 'stats', 'report', 'result', 'state']
    });
    if (!result.ok) {
        return result;
    }
    result = validateEnumField({
        value: match,
        key: 'transport',
        path: 'wait.match',
        allowed: ['realtime', 'messages.rtc', 'ws', 'http']
    });
    if (!result.ok) {
        return result;
    }
    result = validateEnumField({
        value: match,
        key: 'severity',
        path: 'wait.match',
        allowed: ['debug', 'info', 'warning', 'error']
    });
    if (!result.ok) {
        return result;
    }
    for (const field of ['topic', 'commandId', 'connection', 'payloadPath', 'contains']) {
        result = validateStringField({ value: match, key: field, path: 'wait.match', required: false });
        if (!result.ok) {
            return result;
        }
    }
    result = validateBooleanField(match, 'exists', 'wait.match');
    if (!result.ok) {
        return result;
    }
    return validateIntegerField({
        value: match,
        key: 'sinceEpochMs',
        path: 'wait.match',
        options: { minimum: 0 }
    });
}

function validateHttpResponse(value: unknown): ControlCommandValidationResult {
    if (value !== undefined) {
        if (!isJsonRecordValue(value)) {
            return fail('http.request.response must be an object.');
        }
        let result = validateKeys(
            value,
            ['body', 'maxBodyChars', 'acceptedStatusCodes'],
            'http.request.response'
        );
        if (!result.ok) {
            return result;
        }
        if (
            value.body !== undefined &&
            value.body !== 'none' &&
            value.body !== 'text' &&
            value.body !== 'json'
        ) {
            return fail('http.request.response.body must be none, text, or json.');
        }
        result = validateNumberField(value, 'maxBodyChars', 'http.request.response');
        if (!result.ok) {
            return result;
        }
        const acceptedStatusCodes = value.acceptedStatusCodes;
        if (acceptedStatusCodes !== undefined) {
            if (!Array.isArray(acceptedStatusCodes) || acceptedStatusCodes.length === 0) {
                return fail('http.request.response.acceptedStatusCodes must be a non-empty array.');
            }
            if (
                acceptedStatusCodes.some(
                    (status) => !Number.isInteger(status) || status < 100 || status > 599
                )
            ) {
                return fail(
                    'http.request.response.acceptedStatusCodes must contain HTTP status integers from 100 through 599.'
                );
            }
        }
    }
    return { ok: true };
}
