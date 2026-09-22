import { validateRallarRouteId } from '@shared/api/rallar-validation.ts';
import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';
import type { ControlCommandIssue } from './control-command-issue.ts';
import { validateObjectField, validateStringField } from './validate-control-command-fields.ts';

type RoomRouteIdField = 'roomId' | 'applicationId' | 'workspaceId';

const ROOM_ROUTE_ID_LABELS: Readonly<Record<RoomRouteIdField, string>> = {
    roomId: 'Room ID',
    applicationId: 'Application ID',
    workspaceId: 'Workspace ID'
};

const ROOM_ROUTE_ID_FIELDS: readonly RoomRouteIdField[] = ['roomId', 'applicationId', 'workspaceId'];

export function validateControlCommandRoomFields(
    command: RallarBlackBoxTestRecord,
    path: string
): readonly ControlCommandIssue[] {
    return [
        ...ROOM_ROUTE_ID_FIELDS.flatMap((key) => validateStringField(command, key, path)),
        ...ROOM_ROUTE_ID_FIELDS.flatMap((key) => validateRouteIdField(command, key, path)),
        ...validateObjectField(command, 'scope', path),
        ...validateObjectField(command, 'roomRef', path)
    ];
}

function validateRouteIdField(
    command: RallarBlackBoxTestRecord,
    key: RoomRouteIdField,
    path: string
): readonly ControlCommandIssue[] {
    const value = command[key];
    if (typeof value !== 'string') {
        return [];
    }
    return validateRallarRouteId(value, `${path}.${key}`, ROOM_ROUTE_ID_LABELS[key]).issues.map((issue) => ({
        message: `${issue.path}: ${issue.message}`,
        validationIssues: [issue]
    }));
}
