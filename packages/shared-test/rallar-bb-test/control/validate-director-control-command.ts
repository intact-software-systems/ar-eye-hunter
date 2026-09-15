import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_COMMAND_FIELDS } from '../schema/rallar-black-box-command-fields.ts';
import { toControlCommandIssue, type ControlCommandIssue } from './control-command-issue.ts';
import {
    validateBooleanField,
    validateIntegerField,
    validateNumberField,
    validateRequiredField,
    validateStringField
} from './validate-control-command-fields.ts';
import { validateControlCommandRoomFields } from './validate-control-command-room-fields.ts';

export type DirectorControlCommandKind =
    | 'director.appoint'
    | 'director.resign'
    | 'director.status'
    | 'director.relay.start'
    | 'director.intent'
    | 'director.sync.request'
    | 'director.relay.stop';

const RELAY_STRING_FIELDS = [
    'handle',
    'laneId',
    'topicId',
    'intentTypeId',
    'outputTypeId',
    'heartbeatTypeId',
    'snapshotTypeId',
    'syncRequestTypeId'
];

export function validateDirectorControlCommand(
    command: RallarBlackBoxTestRecord,
    kind: DirectorControlCommandKind
): readonly ControlCommandIssue[] {
    switch (kind) {
        case 'director.appoint':
            return [
                ...validateControlCommandRoomFields(command, kind),
                ...validateIntegerField({ record: command, key: 'heartbeatTtlMs', path: kind, minimum: 1 })
            ];
        case 'director.resign':
            return validateControlCommandRoomFields(command, kind);
        case 'director.status':
            return [
                ...validateControlCommandRoomFields(command, kind),
                ...validateBooleanField(command, 'refresh', kind),
                ...validateNumberField(command, 'now', kind)
            ];
        case 'director.relay.start':
            return validateDirectorRelayStartCommand(command);
        case 'director.intent':
            return [
                ...validateRequiredHandle(command, kind),
                ...(Object.hasOwn(command, 'intent')
                    ? []
                    : [toControlCommandIssue('director.intent.intent is required.')])
            ];
        case 'director.sync.request':
        case 'director.relay.stop':
            return validateRequiredHandle(command, kind);
    }
}

function validateDirectorRelayStartCommand(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const path = 'director.relay.start';
    const requiredFields: readonly string[] = RALLAR_BLACK_BOX_COMMAND_FIELDS[path].required;
    return [
        ...validateControlCommandRoomFields(command, path),
        ...RELAY_STRING_FIELDS.flatMap((key) => [
            ...(requiredFields.includes(key) ? validateRequiredField(command, key, path) : []),
            ...validateStringField(command, key, path)
        ]),
        ...['heartbeatIntervalMs', 'snapshotIntervalMs'].flatMap((key) =>
            validateIntegerField({ record: command, key, path, minimum: 0 })
        )
    ];
}

function validateRequiredHandle(
    command: RallarBlackBoxTestRecord,
    path: DirectorControlCommandKind
): readonly ControlCommandIssue[] {
    return [...validateRequiredField(command, 'handle', path), ...validateStringField(command, 'handle', path)];
}
