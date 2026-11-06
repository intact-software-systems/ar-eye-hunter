import {
    requireEpoch,
    requireExactKeys,
    requireRecord,
    requireString
} from '@shared/api/exact-object-decoding.ts';
import { decodeStateScope, type StateScope } from '@shared/api/state-types.ts';
import {
    decodeViewWatchFamily,
    decodeViewWatchRequest,
    type ViewWatchFamily,
    type ViewWatchRequest
} from '@shared/api/views/view-watch.ts';
import type { JsonWireValue } from '../protocol/json-wire-identity.ts';

export interface ViewWatchCommand {
    readonly scope: StateScope;
    readonly family: ViewWatchFamily;
    readonly principalId: string;
    readonly sessionId: string;
    readonly sessionIssuedAtEpochMs: number;
    readonly sessionExpiresAtEpochMs: number;
    readonly requestId: string;
    readonly request: ViewWatchRequest;
}

export function decodeViewWatchCommand(value: JsonWireValue): ViewWatchCommand {
    const command = requireRecord(value, 'View watch command');
    requireExactKeys(command, [
        'scope',
        'family',
        'principalId',
        'sessionId',
        'sessionIssuedAtEpochMs',
        'sessionExpiresAtEpochMs',
        'requestId',
        'request'
    ], 'View watch command');
    requireString(command.principalId, 'Watch principal');
    requireString(command.sessionId, 'Watch session');
    requireString(command.requestId, 'Watch request');
    requireEpoch(command.sessionIssuedAtEpochMs, 'Watch issued time');
    requireEpoch(command.sessionExpiresAtEpochMs, 'Watch expiry');
    return {
        scope: decodeStateScope(command.scope),
        family: decodeViewWatchFamily(command.family),
        principalId: command.principalId,
        sessionId: command.sessionId,
        sessionIssuedAtEpochMs: command.sessionIssuedAtEpochMs,
        sessionExpiresAtEpochMs: command.sessionExpiresAtEpochMs,
        requestId: command.requestId,
        request: decodeViewWatchRequest(command.request)
    };
}
