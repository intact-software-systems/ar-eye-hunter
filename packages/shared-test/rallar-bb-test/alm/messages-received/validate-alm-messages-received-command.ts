import { toControlCommandIssue, type ControlCommandIssue } from '../../control/control-command-issue.ts';
import {
    validateBooleanField,
    validateIntegerField,
    validateStringField
} from '../../control/validate-control-command-fields.ts';
import type { RallarBlackBoxTestRecord } from '../../rallar-black-box-test-contracts.ts';

const PATH = 'messages.received';

/** A count's fields; an order claim and a stall window bound a presence claim, so an absence claim takes neither. */
export function validateAlmMessagesReceivedCommand(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    return [
        ...validateStringField(command, 'connection', PATH),
        ...validateStringField(command, 'typeId', PATH),
        ...validateStringField(command, 'msgId', PATH),
        ...validateIntegerField({ record: command, key: 'count', path: PATH, minimum: 0 }),
        ...validateBooleanField(command, 'absent', PATH),
        ...validateOrderField(command),
        ...validateStallField(command),
        ...validateIntegerField({ record: command, key: 'windowMs', path: PATH, minimum: 0 })
    ];
}

function validateOrderField(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const field = command.ascendingBy;
    if (typeof field !== 'string') {
        return validateStringField(command, 'ascendingBy', PATH);
    }
    if (field.trim() === '') {
        return [toControlCommandIssue(`${PATH}.ascendingBy must name a payload field.`)];
    }
    return command.absent === true
        ? [toControlCommandIssue(
            `${PATH}.ascendingBy claims an order, which an absence claim (absent: true) has none of.`
        )]
        : [];
}

function validateStallField(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const issues = validateIntegerField({ record: command, key: 'stallMs', path: PATH, minimum: 1 });
    if (issues.length > 0 || command.stallMs === undefined || command.absent !== true) {
        return issues;
    }
    return [
        toControlCommandIssue(
            `${PATH}.stallMs ends a count that stops arriving, which an absence claim (absent: true) never ends early.`
        )
    ];
}
