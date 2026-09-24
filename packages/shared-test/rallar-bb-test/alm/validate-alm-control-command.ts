import { AL_DELIVERY_STATES } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { toControlCommandIssue, type ControlCommandIssue } from '../control/control-command-issue.ts';
import {
    validateAllowedFields,
    validateBooleanField,
    validateEnumField,
    validateIntegerField,
    validateNumberField,
    validateObjectField,
    validateRequiredFields,
    validateStringField
} from '../control/validate-control-command-fields.ts';
import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import {
    RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES,
    RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS
} from '../schema/rallar-black-box-command-fields.ts';

export type RallarBlackBoxTestAlmCommandKind =
    | 'messages.send'
    | 'messages.observe'
    | 'messages.cancel'
    | 'messages.received'
    | 'messages.receipts'
    | 'fault.inject'
    | 'storage.counters'
    | 'agent.reload';

export function validateAlmControlCommand(
    command: RallarBlackBoxTestRecord,
    kind: RallarBlackBoxTestAlmCommandKind
): readonly ControlCommandIssue[] {
    switch (kind) {
        case 'messages.send':
            return validateMessagesSendCommand(command);
        case 'messages.observe':
            return [...validateMessagesHandleCommand(command, kind), ...validateDeliveryStateField(command)];
        case 'messages.cancel':
        case 'messages.receipts':
            return validateMessagesHandleCommand(command, kind);
        case 'messages.received':
            return validateMessagesReceivedCommand(command);
        case 'fault.inject':
            return validateFaultInjectCommand(command);
        case 'storage.counters':
            return validateBooleanField(command, 'reset', kind);
        case 'agent.reload':
            return validateIntegerField({ record: command, key: 'readyTimeoutMs', path: kind, minimum: 0 });
    }
}

function validateMessagesSendCommand(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const path = 'messages.send';
    const values = RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES;
    return [
        ...validateStringField(command, 'connection', path),
        ...validateEnumField({ record: command, key: 'carrier', path, allowed: values.messagesCarrier }),
        ...validateStringField(command, 'typeId', path),
        ...['topicId', 'orderingKey', 'handleId'].flatMap((key) => validateStringField(command, key, path)),
        ...validateObjectField(command, 'roomRef', path),
        ...validateEnumField({ record: command, key: 'scope', path, allowed: values.messagesScope }),
        ...validateEnumField({ record: command, key: 'reliability', path, allowed: values.messagesReliability }),
        ...validateEnumField({ record: command, key: 'ack', path, allowed: values.messagesAck }),
        ...validateIntegerField({ record: command, key: 'ttlMs', path, minimum: 0 }),
        ...validateNumberField(command, 'seq', path),
        ...validateMessagesReplayField(command)
    ];
}

function validateMessagesReplayField(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const replay = command.replayOnCarrier;
    const path = 'messages.send.replayOnCarrier';
    if (replay === undefined) {
        return [];
    }
    if (!isJsonRecordValue(replay)) {
        return [toControlCommandIssue(`${path} must be an object.`)];
    }
    const fields = RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.messagesReplay;
    return [
        ...validateAllowedFields(replay, fields, path),
        ...validateRequiredFields({ record: replay, fields, path, ownMessageFields: [] }),
        ...validateStringField(replay, 'handleId', path),
        ...validateEnumField({
            record: replay,
            key: 'carrier',
            path,
            allowed: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.messagesReplayCarrier
        })
    ];
}

function validateMessagesHandleCommand(
    command: RallarBlackBoxTestRecord,
    path: RallarBlackBoxTestAlmCommandKind
): readonly ControlCommandIssue[] {
    return [...validateStringField(command, 'connection', path), ...validateStringField(command, 'handleId', path)];
}

function validateDeliveryStateField(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const state = command.state;
    if (!Array.isArray(state) || state.length === 0) {
        return [toControlCommandIssue('messages.observe.state must list at least one delivery state.')];
    }
    return state.every((entry) => AL_DELIVERY_STATES.some((deliveryState) => deliveryState === entry))
        ? []
        : [toControlCommandIssue(`messages.observe.state must list only ${AL_DELIVERY_STATES.join(', ')}.`)];
}

function validateMessagesReceivedCommand(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const path = 'messages.received';
    return [
        ...validateStringField(command, 'connection', path),
        ...validateStringField(command, 'typeId', path),
        ...validateStringField(command, 'msgId', path),
        ...validateIntegerField({ record: command, key: 'count', path, minimum: 0 }),
        ...validateBooleanField(command, 'absent', path),
        ...validateIntegerField({ record: command, key: 'windowMs', path, minimum: 0 })
    ];
}

function validateFaultInjectCommand(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const path = 'fault.inject';
    return [
        ...validateStringField(command, 'faultId', path),
        ...validateEnumField({
            record: command,
            key: 'carrier',
            path,
            allowed: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.faultCarrier
        }),
        ...validateFaultMatchField(command),
        ...validateFaultActionField(command),
        ...(command.remaining === 'until-cleared' ? [] : validateNumberField(command, 'remaining', path))
    ];
}

function validateFaultMatchField(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const match = command.match;
    const path = 'fault.inject.match';
    if (!isJsonRecordValue(match)) {
        return [toControlCommandIssue(`${path} must be an object.`)];
    }
    return [
        ...validateAllowedFields(match, RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.faultMatch, path),
        ...validateEnumField({
            record: match,
            key: 'controlType',
            path,
            allowed: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.faultControlType
        }),
        ...validateStringField(match, 'typeId', path),
        ...validateStringField(match, 'msgId', path)
    ];
}

function validateFaultActionField(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const action = command.action;
    const path = 'fault.inject.action';
    if (action === undefined || action === 'drop') {
        return [];
    }
    if (command.carrier === 'rtc') {
        return [toControlCommandIssue(`${path} must be "drop" on the rtc carrier.`)];
    }
    if (action === 'not-ready') {
        return [];
    }
    if (!isJsonRecordValue(action)) {
        return [toControlCommandIssue(`${path} must be "drop", "not-ready" or an object with delayMs.`)];
    }
    const fields = RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.faultDelayAction;
    return [
        ...validateAllowedFields(action, fields, path),
        ...validateRequiredFields({ record: action, fields, path, ownMessageFields: [] }),
        ...validateNumberField(action, 'delayMs', path)
    ];
}
