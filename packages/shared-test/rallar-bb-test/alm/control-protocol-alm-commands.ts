import type { ControlCommandValidationResult } from '../control-protocol.ts';
import type { RallarBlackBoxTestRecord } from '../types.ts';

export type RallarBlackBoxTestAlmCommandKind =
    | 'messages.send'
    | 'messages.observe'
    | 'messages.cancel'
    | 'messages.received'
    | 'messages.receipts'
    | 'fault.inject'
    | 'storage.counters'
    | 'agent.reload';

export interface ValidateAlmControlCommandInput {
    readonly command: RallarBlackBoxTestRecord;
    readonly kind: RallarBlackBoxTestAlmCommandKind;
    readonly baseFields: readonly string[];
}

interface ValidateEnumFieldInput {
    readonly command: RallarBlackBoxTestRecord;
    readonly key: string;
    readonly path: string;
    readonly allowed: readonly string[];
}

interface ValidateIntegerFieldInput {
    readonly command: RallarBlackBoxTestRecord;
    readonly key: string;
    readonly path: string;
    readonly minimum: number;
}

const MESSAGES_CARRIERS = ['ws', 'rtc', 'rtc-with-ws-fallback'];
const MESSAGES_SCOPES = ['room', 'world', 'all'];
const MESSAGES_RELIABILITIES = ['best-effort', 'at-least-once'];
const MESSAGES_ACKS = ['none', 'receiver', 'all-logical-recipients', 'group-leader'];
const FAULT_CARRIERS = ['ws', 'rtc'];
const FAULT_CONTROL_TYPES = ['ack', 'nack', 'repair'];

const ALM_COMMAND_FIELDS: Readonly<Record<RallarBlackBoxTestAlmCommandKind, readonly string[]>> = {
    'messages.send': [
        'connection',
        'carrier',
        'typeId',
        'topicId',
        'payload',
        'roomRef',
        'scope',
        'reliability',
        'ack',
        'ttlMs',
        'orderingKey',
        'seq',
        'key',
        'toPeerId',
        'handleId'
    ],
    'messages.observe': ['connection', 'handleId', 'state'],
    'messages.cancel': ['connection', 'handleId'],
    'messages.received': ['connection', 'typeId', 'msgId', 'count', 'absent', 'windowMs'],
    'messages.receipts': ['connection', 'handleId'],
    'fault.inject': ['faultId', 'carrier', 'match', 'action', 'remaining'],
    'storage.counters': ['reset'],
    'agent.reload': ['readyTimeoutMs']
};

const accepted: ControlCommandValidationResult = { ok: true };

export function validateAlmControlCommand(
    input: ValidateAlmControlCommandInput
): ControlCommandValidationResult {
    const keys = validateKeysOf(
        input.command,
        [...input.baseFields, ...ALM_COMMAND_FIELDS[input.kind]],
        input.kind
    );
    return keys.ok ? validateAlmCommandFields(input.command, input.kind) : keys;
}

function validateAlmCommandFields(
    command: RallarBlackBoxTestRecord,
    kind: RallarBlackBoxTestAlmCommandKind
): ControlCommandValidationResult {
    switch (kind) {
        case 'messages.send':
            return validateMessagesSendCommand(command);
        case 'messages.observe':
            return validateMessagesObserveCommand(command);
        case 'messages.cancel':
            return validateMessagesHandleCommand(command, 'messages.cancel');
        case 'messages.received':
            return validateMessagesReceivedCommand(command);
        case 'messages.receipts':
            return validateMessagesHandleCommand(command, 'messages.receipts');
        case 'fault.inject':
            return validateFaultInjectCommand(command);
        case 'storage.counters':
            return validateOptionalBooleanField(command, 'reset', 'storage.counters');
        case 'agent.reload':
            return validateRequiredIntegerField({
                command,
                key: 'readyTimeoutMs',
                path: 'agent.reload',
                minimum: 0
            });
    }
}

function validateMessagesSendCommand(
    command: RallarBlackBoxTestRecord
): ControlCommandValidationResult {
    return toFirstFailure([
        validateOptionalStringField(command, 'connection', 'messages.send'),
        validateRequiredEnumField({
            command,
            key: 'carrier',
            path: 'messages.send',
            allowed: MESSAGES_CARRIERS
        }),
        validateRequiredStringField(command, 'typeId', 'messages.send'),
        validateRequiredPayloadField(command),
        validateMessagesSendOptionalFields(command)
    ]);
}

function validateRequiredPayloadField(
    command: RallarBlackBoxTestRecord
): ControlCommandValidationResult {
    return command.payload === undefined ? fail('messages.send.payload is required.') : accepted;
}

function validateMessagesSendOptionalFields(
    command: RallarBlackBoxTestRecord
): ControlCommandValidationResult {
    return toFirstFailure([
        validateOptionalStringField(command, 'topicId', 'messages.send'),
        validateOptionalStringField(command, 'orderingKey', 'messages.send'),
        validateOptionalStringField(command, 'key', 'messages.send'),
        validateOptionalStringField(command, 'toPeerId', 'messages.send'),
        validateOptionalStringField(command, 'handleId', 'messages.send'),
        validateOptionalRecordField(command, 'roomRef', 'messages.send'),
        validateOptionalEnumField({
            command,
            key: 'scope',
            path: 'messages.send',
            allowed: MESSAGES_SCOPES
        }),
        validateOptionalEnumField({
            command,
            key: 'reliability',
            path: 'messages.send',
            allowed: MESSAGES_RELIABILITIES
        }),
        validateOptionalEnumField({
            command,
            key: 'ack',
            path: 'messages.send',
            allowed: MESSAGES_ACKS
        }),
        validateOptionalIntegerField({ command, key: 'ttlMs', path: 'messages.send', minimum: 0 }),
        validateOptionalNumberField(command, 'seq', 'messages.send')
    ]);
}

function validateMessagesObserveCommand(
    command: RallarBlackBoxTestRecord
): ControlCommandValidationResult {
    return toFirstFailure([
        validateOptionalStringField(command, 'connection', 'messages.observe'),
        validateRequiredStringField(command, 'handleId', 'messages.observe'),
        validateDeliveryStateField(command)
    ]);
}

function validateMessagesHandleCommand(
    command: RallarBlackBoxTestRecord,
    path: string
): ControlCommandValidationResult {
    return toFirstFailure([
        validateOptionalStringField(command, 'connection', path),
        validateRequiredStringField(command, 'handleId', path)
    ]);
}

function validateMessagesReceivedCommand(
    command: RallarBlackBoxTestRecord
): ControlCommandValidationResult {
    return toFirstFailure([
        validateOptionalStringField(command, 'connection', 'messages.received'),
        validateRequiredStringField(command, 'typeId', 'messages.received'),
        validateOptionalStringField(command, 'msgId', 'messages.received'),
        validateRequiredIntegerField({
            command,
            key: 'count',
            path: 'messages.received',
            minimum: 0
        }),
        validateOptionalBooleanField(command, 'absent', 'messages.received'),
        validateRequiredIntegerField({
            command,
            key: 'windowMs',
            path: 'messages.received',
            minimum: 0
        })
    ]);
}

function validateFaultInjectCommand(
    command: RallarBlackBoxTestRecord
): ControlCommandValidationResult {
    return toFirstFailure([
        validateRequiredStringField(command, 'faultId', 'fault.inject'),
        validateRequiredEnumField({
            command,
            key: 'carrier',
            path: 'fault.inject',
            allowed: FAULT_CARRIERS
        }),
        validateFaultMatchField(command),
        validateFaultActionField(command),
        validateRequiredNumberField(command, 'remaining', 'fault.inject')
    ]);
}

function validateFaultMatchField(
    command: RallarBlackBoxTestRecord
): ControlCommandValidationResult {
    const match = command.match;
    if (!isAlmCommandRecord(match)) {
        return fail('fault.inject.match must be an object.');
    }
    return toFirstFailure([
        validateKeysOf(match, ['controlType', 'typeId', 'msgId'], 'fault.inject.match'),
        validateOptionalEnumField({
            command: match,
            key: 'controlType',
            path: 'fault.inject.match',
            allowed: FAULT_CONTROL_TYPES
        }),
        validateOptionalStringField(match, 'typeId', 'fault.inject.match'),
        validateOptionalStringField(match, 'msgId', 'fault.inject.match')
    ]);
}

function validateFaultActionField(
    command: RallarBlackBoxTestRecord
): ControlCommandValidationResult {
    const action = command.action;
    if (action === undefined) {
        return fail('fault.inject.action is required.');
    }
    if (action === 'drop') {
        return accepted;
    }
    if (!isAlmCommandRecord(action)) {
        return fail('fault.inject.action must be "drop" or an object with delayMs.');
    }
    return toFirstFailure([
        validateKeysOf(action, ['delayMs'], 'fault.inject.action'),
        validateRequiredNumberField(action, 'delayMs', 'fault.inject.action')
    ]);
}

function validateDeliveryStateField(
    command: RallarBlackBoxTestRecord
): ControlCommandValidationResult {
    const state = command.state;
    return Array.isArray(state) && state.every((entry) => typeof entry === 'string')
        ? accepted
        : fail('messages.observe.state must be a string array.');
}

function validateKeysOf(
    command: RallarBlackBoxTestRecord,
    allowed: readonly string[],
    path: string
): ControlCommandValidationResult {
    const unexpected = Object.keys(command).find((key) => !allowed.includes(key));
    return unexpected === undefined
        ? accepted
        : fail(`${path} has unsupported field: ${unexpected}.`);
}

function validateOptionalStringField(
    command: RallarBlackBoxTestRecord,
    key: string,
    path: string
): ControlCommandValidationResult {
    const value = command[key];
    return value === undefined || typeof value === 'string'
        ? accepted
        : fail(`${path}.${key} must be a string.`);
}

function validateRequiredStringField(
    command: RallarBlackBoxTestRecord,
    key: string,
    path: string
): ControlCommandValidationResult {
    return command[key] === undefined
        ? fail(`${path}.${key} is required.`)
        : validateOptionalStringField(command, key, path);
}

function validateOptionalEnumField(input: ValidateEnumFieldInput): ControlCommandValidationResult {
    const value = input.command[input.key];
    if (value === undefined) {
        return accepted;
    }
    return typeof value === 'string' && input.allowed.includes(value)
        ? accepted
        : fail(`${input.path}.${input.key} must be one of ${input.allowed.join(', ')}.`);
}

function validateRequiredEnumField(input: ValidateEnumFieldInput): ControlCommandValidationResult {
    return input.command[input.key] === undefined
        ? fail(`${input.path}.${input.key} is required.`)
        : validateOptionalEnumField(input);
}

function validateOptionalNumberField(
    command: RallarBlackBoxTestRecord,
    key: string,
    path: string
): ControlCommandValidationResult {
    const value = command[key];
    if (value === undefined) {
        return accepted;
    }
    if (typeof value !== 'number') {
        return fail(`${path}.${key} must be a number.`);
    }
    return Number.isFinite(value) ? accepted : fail(`${path}.${key} must be a finite number.`);
}

function validateRequiredNumberField(
    command: RallarBlackBoxTestRecord,
    key: string,
    path: string
): ControlCommandValidationResult {
    return command[key] === undefined
        ? fail(`${path}.${key} is required.`)
        : validateOptionalNumberField(command, key, path);
}

function validateOptionalIntegerField(
    input: ValidateIntegerFieldInput
): ControlCommandValidationResult {
    const value = input.command[input.key];
    if (value === undefined) {
        return accepted;
    }
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        return fail(`${input.path}.${input.key} must be an integer.`);
    }
    return value >= input.minimum
        ? accepted
        : fail(`${input.path}.${input.key} must be >= ${input.minimum}.`);
}

function validateRequiredIntegerField(
    input: ValidateIntegerFieldInput
): ControlCommandValidationResult {
    return input.command[input.key] === undefined
        ? fail(`${input.path}.${input.key} is required.`)
        : validateOptionalIntegerField(input);
}

function validateOptionalBooleanField(
    command: RallarBlackBoxTestRecord,
    key: string,
    path: string
): ControlCommandValidationResult {
    const value = command[key];
    return value === undefined || typeof value === 'boolean'
        ? accepted
        : fail(`${path}.${key} must be a boolean.`);
}

function validateOptionalRecordField(
    command: RallarBlackBoxTestRecord,
    key: string,
    path: string
): ControlCommandValidationResult {
    const value = command[key];
    return value === undefined || isAlmCommandRecord(value)
        ? accepted
        : fail(`${path}.${key} must be an object.`);
}

function toFirstFailure(
    results: readonly ControlCommandValidationResult[]
): ControlCommandValidationResult {
    return results.find((result) => !result.ok) ?? accepted;
}

function isAlmCommandRecord(value: unknown): value is RallarBlackBoxTestRecord {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fail(message: string): ControlCommandValidationResult {
    return { ok: false, error: message };
}
