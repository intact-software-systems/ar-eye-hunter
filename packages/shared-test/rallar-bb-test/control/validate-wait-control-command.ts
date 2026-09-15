import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import {
    RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES,
    RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS
} from '../schema/rallar-black-box-command-fields.ts';
import { toControlCommandIssue, type ControlCommandIssue } from './control-command-issue.ts';
import {
    validateAllowedFields,
    validateBooleanField,
    validateEnumField,
    validateIntegerField,
    validateStringField
} from './validate-control-command-fields.ts';

const WAIT_MATCH_PATH = 'wait.match';

export function validateWaitControlCommand(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const match = command.match;
    if (!isJsonRecordValue(match)) {
        return [toControlCommandIssue('wait.match is required.')];
    }
    return [
        ...(command.absent === undefined || command.absent === true
            ? []
            : [toControlCommandIssue('wait.absent must be true when present.')]),
        ...validateAllowedFields(match, RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.waitMatch, WAIT_MATCH_PATH),
        ...validateWaitMatchFields(match)
    ];
}

function validateWaitMatchFields(match: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const values = RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES;
    return [
        ...validateEnumField({ record: match, key: 'kind', path: WAIT_MATCH_PATH, allowed: values.waitMatchKind }),
        ...validateEnumField({
            record: match,
            key: 'transport',
            path: WAIT_MATCH_PATH,
            allowed: values.waitMatchTransport
        }),
        ...validateEnumField({
            record: match,
            key: 'severity',
            path: WAIT_MATCH_PATH,
            allowed: values.waitMatchSeverity
        }),
        ...['topic', 'commandId', 'connection', 'payloadPath', 'contains'].flatMap((key) =>
            validateStringField(match, key, WAIT_MATCH_PATH)
        ),
        ...validateBooleanField(match, 'exists', WAIT_MATCH_PATH),
        ...validateIntegerField({ record: match, key: 'sinceEpochMs', path: WAIT_MATCH_PATH, minimum: 0 })
    ];
}
