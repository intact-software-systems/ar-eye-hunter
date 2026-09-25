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
    RALLAR_BLACK_BOX_COMMAND_FIELDS,
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

/** A replay names only the earlier handle and its carrier: the replayed envelope already fixes everything else. */
function validateMessagesSendCommand(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    return command.replayOnCarrier === undefined
        ? validateOrdinaryMessagesSendCommand(command)
        : validateMessagesReplayCommand(command);
}

function validateMessagesReplayCommand(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const fields = RALLAR_BLACK_BOX_COMMAND_FIELDS['messages.send'];
    const refused = [...fields.required, ...fields.optional].filter((field) =>
        field !== 'connection' && field !== 'replayOnCarrier' && command[field] !== undefined
    );
    return [
        ...refused.map((field) =>
            toControlCommandIssue(
                `messages.send.${field} is not allowed on a replay; a replay names only connection and replayOnCarrier.`
            )
        ),
        ...validateStringField(command, 'connection', 'messages.send'),
        ...validateMessagesReplayField(command)
    ];
}

function validateOrdinaryMessagesSendCommand(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const path = 'messages.send';
    const values = RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES;
    return [
        ...validateRequiredFields({
            record: command,
            fields: RALLAR_BLACK_BOX_COMMAND_FIELDS[path],
            path,
            ownMessageFields: []
        }),
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
        ...validateMessagesSnapshotFloorField(command),
        ...validateMessagesQosField(command)
    ];
}

function validateMessagesSnapshotFloorField(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const floor = command.minSnapshotVersion;
    const path = 'messages.send.minSnapshotVersion';
    if (floor === undefined) {
        return [];
    }
    if (!isJsonRecordValue(floor)) {
        return [toControlCommandIssue(`${path} must be an object.`)];
    }
    const fields = RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.messagesSnapshotFloor;
    const named = fields.optional.filter((field) => floor[field] !== undefined);
    return [
        ...validateAllowedFields(floor, fields, path),
        ...(named.length === 1
            ? []
            : [toControlCommandIssue(`${path} must name exactly one of ${fields.optional.join(', ')}.`)]),
        ...named.flatMap((key) => validateIntegerField({ record: floor, key, path, minimum: 1 }))
    ];
}

function validateMessagesQosField(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const qos = command.qos;
    const path = 'messages.send.qos';
    if (qos === undefined) {
        return [];
    }
    if (!isJsonRecordValue(qos)) {
        return [toControlCommandIssue(`${path} must be an object.`)];
    }
    const fields = RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.messagesQos;
    return [
        ...validateAllowedFields(qos, fields, path),
        ...validateRequiredFields({ record: qos, fields, path, ownMessageFields: [] }),
        ...validateMessagesQosAckField(qos)
    ];
}

function validateMessagesQosAckField(qos: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const ack = qos.ack;
    const path = 'messages.send.qos.ack';
    if (ack === undefined) {
        return [];
    }
    if (!isJsonRecordValue(ack)) {
        return [toControlCommandIssue(`${path} must be an object.`)];
    }
    const fields = RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.messagesQosAck;
    return [
        ...validateAllowedFields(ack, fields, path),
        ...validateRequiredFields({ record: ack, fields, path, ownMessageFields: [] }),
        ...validateEnumField({
            record: ack,
            key: 'algo',
            path,
            allowed: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.messagesQosAckAlgo
        })
    ];
}

function validateMessagesReplayField(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const replay = command.replayOnCarrier;
    const path = 'messages.send.replayOnCarrier';
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
