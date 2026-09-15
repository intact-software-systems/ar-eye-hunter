import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';
import { toControlCommandIssue, type ControlCommandIssue } from './control-command-issue.ts';
import {
    validateNumberField,
    validateStringField,
    validateStringRecordField
} from './validate-control-command-fields.ts';

export type WsControlCommandKind = 'ws.open' | 'ws.send' | 'ws.close';

export function validateWsControlCommand(
    command: RallarBlackBoxTestRecord,
    kind: WsControlCommandKind
): readonly ControlCommandIssue[] {
    const connectionIssues = validateStringField(command, 'connection', 'ws');
    switch (kind) {
        case 'ws.open':
            return [
                ...connectionIssues,
                ...validateStringField(command, 'url', 'ws.open'),
                ...validateWsProtocols(command),
                ...validateStringRecordField(command, 'headers', 'ws.open')
            ];
        case 'ws.close':
            return [
                ...connectionIssues,
                ...validateNumberField(command, 'code', 'ws.close'),
                ...validateStringField(command, 'reason', 'ws.close')
            ];
        case 'ws.send':
            return connectionIssues;
    }
}

function validateWsProtocols(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const protocols = command.protocols;
    const valid = protocols === undefined ||
        typeof protocols === 'string' ||
        (Array.isArray(protocols) && protocols.every((protocol) => typeof protocol === 'string'));
    return valid ? [] : [toControlCommandIssue('ws.open.protocols must be a string or string array.')];
}
