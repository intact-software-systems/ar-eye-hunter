import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES } from '../schema/rallar-black-box-command-fields.ts';
import { toControlCommandIssue, type ControlCommandIssue } from './control-command-issue.ts';
import {
    validateEnumField,
    validateObjectField,
    validateRequiredField,
    validateStringField
} from './validate-control-command-fields.ts';
import { validateControlCommandRoomFields } from './validate-control-command-room-fields.ts';

export type FormationControlCommandKind = 'formation.command' | 'formation.readiness';

export function validateFormationControlCommand(
    command: RallarBlackBoxTestRecord,
    kind: FormationControlCommandKind
): readonly ControlCommandIssue[] {
    const roomIssues = validateFormationRoomIdentity(command, kind);
    return kind === 'formation.command' ? [...roomIssues, ...validateFormationCommandFields(command)] : roomIssues;
}

function validateFormationRoomIdentity(
    command: RallarBlackBoxTestRecord,
    path: FormationControlCommandKind
): readonly ControlCommandIssue[] {
    const namesRoom = command.roomRef !== undefined ||
        (typeof command.applicationId === 'string' && typeof command.roomId === 'string');
    return [
        ...validateControlCommandRoomFields(command, path),
        ...(namesRoom
            ? []
            : [toControlCommandIssue(`${path} must name its room with roomRef, or with applicationId and roomId.`)])
    ];
}

function validateFormationCommandFields(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const path = 'formation.command';
    const name = command.command;
    return [
        ...validateRequiredField(command, 'command', path),
        ...validateStringField(command, 'command', path),
        ...(typeof name === 'string'
            ? validateEnumField({
                record: command,
                key: 'command',
                path,
                allowed: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.formationCommand
            })
            : []),
        ...(command.layout !== undefined && name !== 'connect'
            ? [toControlCommandIssue(`${path} ${String(name)} does not take layout.`)]
            : []),
        ...(command.landing !== undefined && name !== 'reconfigure'
            ? [toControlCommandIssue(`${path} ${String(name)} does not take landing.`)]
            : []),
        ...validateObjectField(command, 'layout', path),
        ...validateStringField(command, 'landing', path),
        ...validateStringField(command, 'reason', path)
    ];
}
