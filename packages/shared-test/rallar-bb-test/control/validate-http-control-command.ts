import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import {
    RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES,
    RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS
} from '../schema/rallar-black-box-command-fields.ts';
import { toControlCommandIssue, type ControlCommandIssue } from './control-command-issue.ts';
import {
    validateAllowedFields,
    validateNumberField,
    validateStringField,
    validateStringRecordField
} from './validate-control-command-fields.ts';

const REQUEST_PATH = 'http.request.request';
const RESPONSE_PATH = 'http.request.response';

export function validateHttpControlCommand(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const request = command.request;
    if (!isJsonRecordValue(request)) {
        return [toControlCommandIssue(`${REQUEST_PATH} is required.`)];
    }
    return [
        ...validateAllowedFields(request, RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.httpRequest, REQUEST_PATH),
        ...(request.url === undefined && request.path === undefined
            ? [toControlCommandIssue(`${REQUEST_PATH} requires url or path.`)]
            : []),
        ...['url', 'path', 'method', 'credentials', 'mode'].flatMap((key) =>
            validateStringField(request, key, REQUEST_PATH)
        ),
        ...validateStringRecordField(request, 'headers', REQUEST_PATH),
        ...validateHttpResponse(command)
    ];
}

function validateHttpResponse(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const response = command.response;
    if (response === undefined) {
        return [];
    }
    if (!isJsonRecordValue(response)) {
        return [toControlCommandIssue(`${RESPONSE_PATH} must be an object.`)];
    }
    const bodies: readonly string[] = RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.httpResponseBody;
    return [
        ...validateAllowedFields(response, RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.httpResponse, RESPONSE_PATH),
        ...(response.body === undefined || (typeof response.body === 'string' && bodies.includes(response.body))
            ? []
            : [toControlCommandIssue(`${RESPONSE_PATH}.body must be none, text, or json.`)]),
        ...validateNumberField(response, 'maxBodyChars', RESPONSE_PATH),
        ...validateAcceptedStatusCodes(response)
    ];
}

function validateAcceptedStatusCodes(response: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const statusCodes = response.acceptedStatusCodes;
    if (statusCodes === undefined) {
        return [];
    }
    if (!Array.isArray(statusCodes) || statusCodes.length === 0) {
        return [toControlCommandIssue(`${RESPONSE_PATH}.acceptedStatusCodes must be a non-empty array.`)];
    }
    return statusCodes.every((status) => Number.isInteger(status) && status >= 100 && status <= 599)
        ? []
        : [
            toControlCommandIssue(
                `${RESPONSE_PATH}.acceptedStatusCodes must contain HTTP status integers from 100 through 599.`
            )
        ];
}
