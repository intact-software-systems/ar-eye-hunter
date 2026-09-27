import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';
import { toControlCommandIssue, type ControlCommandIssue } from './control-command-issue.ts';
import { validateIntegerField } from './validate-control-command-fields.ts';

export function validateBarrierControlCommand(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const barrierId = command.barrierId;
    return [
        ...(typeof barrierId === 'string' && barrierId.trim().length > 0
            ? []
            : [toControlCommandIssue('barrier.barrierId must be a non-empty string.')]),
        ...validateIntegerField({ record: command, key: 'timeoutMs', path: 'barrier', minimum: 1 }),
        ...validateBarrierParticipants(command)
    ];
}

function validateBarrierParticipants(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const participants = command.participants;
    if (participants === undefined) {
        return [];
    }
    const distinctRoles = Array.isArray(participants) && participants.length > 0 &&
        participants.every((role) => typeof role === 'string' && role.length > 0) &&
        new Set(participants).size === participants.length;
    return distinctRoles
        ? []
        : [toControlCommandIssue('barrier.participants must be a non-empty list of distinct role names.')];
}
