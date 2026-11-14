import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';
import { decodeJsonValue } from '../runtime/decode-runtime-result-values.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import {
    RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES,
    RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS
} from '../schema/rallar-black-box-command-fields.ts';
import { WAIT_TIMEOUT_FROM_PATTERN_SOURCE } from '../wait/resolve-wait-match-result-references.ts';
import { toControlCommandIssue, type ControlCommandIssue } from './control-command-issue.ts';
import {
    validateAllowedFields,
    validateBooleanField,
    validateEnumField,
    validateIntegerField,
    validateStringField
} from './validate-control-command-fields.ts';

const WAIT_MATCH_PATH = 'wait.match';
const WAIT_TIMEOUT_FROM_PATTERN = new RegExp(WAIT_TIMEOUT_FROM_PATTERN_SOURCE);

export function validateWaitControlCommand(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const match = command.match;
    if (!isJsonRecordValue(match)) {
        return [toControlCommandIssue('wait.match is required.')];
    }
    return [
        ...(command.absent === undefined || command.absent === true
            ? []
            : [toControlCommandIssue('wait.absent must be true when present.')]),
        ...validateWaitTimeoutFrom(command),
        ...validateAllowedFields(match, RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.waitMatch, WAIT_MATCH_PATH),
        ...validateWaitMatchFields(match)
    ];
}

function validateWaitTimeoutFrom(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const timeoutFrom = command.timeoutFrom;
    if (typeof timeoutFrom !== 'string') {
        return validateStringField(command, 'timeoutFrom', 'wait');
    }
    return WAIT_TIMEOUT_FROM_PATTERN.test(timeoutFrom)
        ? []
        : [toControlCommandIssue('wait.timeoutFrom must be exactly one {resultCache.<commandId>.<path>} reference.')];
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
        ...['topic', 'commandId', 'connection', 'payloadPath', 'contains', 'sinceCommandIdPrefix'].flatMap((key) =>
            validateStringField(match, key, WAIT_MATCH_PATH)
        ),
        ...validateBooleanField(match, 'exists', WAIT_MATCH_PATH),
        ...validateWaitPayloadFields(match),
        ...validateWaitPayloadMinimums(match),
        ...validateIntegerField({ record: match, key: 'sinceEpochMs', path: WAIT_MATCH_PATH, minimum: 0 })
    ];
}

function validateWaitPayloadFields(match: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const payloadFields = match.payloadFields;
    if (payloadFields === undefined) {
        return [];
    }
    if (!isJsonRecordValue(payloadFields)) {
        return [toControlCommandIssue('wait.match.payloadFields must be an object.')];
    }
    return Object.entries(payloadFields).flatMap(([path, expected]) =>
        decodeJsonValue(expected) === undefined
            ? [toControlCommandIssue(`wait.match.payloadFields[${JSON.stringify(path)}] must have a JSON value.`)]
            : []
    );
}

function validateWaitPayloadMinimums(match: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const payloadMinimums = match.payloadMinimums;
    if (payloadMinimums === undefined) {
        return [];
    }
    if (!isJsonRecordValue(payloadMinimums)) {
        return [toControlCommandIssue('wait.match.payloadMinimums must be an object.')];
    }
    return Object.entries(payloadMinimums).flatMap(([path, minimum]) =>
        (typeof minimum === 'number' && Number.isFinite(minimum)) ||
            (typeof minimum === 'string' && WAIT_TIMEOUT_FROM_PATTERN.test(minimum))
            ? []
            : [
                toControlCommandIssue(
                    `wait.match.payloadMinimums[${
                        JSON.stringify(path)
                    }] must be a finite number or exactly one {resultCache.<commandId>.<path>} reference.`
                )
            ]
    );
}
