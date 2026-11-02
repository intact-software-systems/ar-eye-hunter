import { isSameGroupScope } from '@shared/api/api-type-utils.ts';
import { requireEpoch, requireExactKeys, requireRecord, requireString } from '@shared/api/exact-object-decoding.ts';
import { decodeMatchmakingPolicy, type MatchmakingPolicy } from '@shared/api/matchmaking/matchmaking-policy.ts';
import {
    decodeMatchmakingMutationResult,
    decodeMatchmakingRequest,
    decodeMatchmakingScope,
    type MatchmakingMutationResult,
    type MatchmakingRequest
} from '@shared/api/matchmaking/matchmaking-request.ts';
import type { StateScope } from '@shared/api/state-types.ts';

export interface MatchmakingCommand {
    readonly scope: StateScope;
    readonly principalId: string;
    readonly sessionId: string;
    readonly sessionIssuedAtEpochMs: number;
    readonly sessionExpiresAtEpochMs: number;
    readonly requestId: string;
    readonly request: MatchmakingRequest;
    readonly capturedAtEpochMs: number | null;
    readonly policy: MatchmakingPolicy | null;
    readonly serviceId: string | null;
}

export function decodeMatchmakingCommand(value: unknown): MatchmakingCommand {
    const command = requireRecord(value, 'Matchmaking command');
    requireExactKeys(command, [
        'scope',
        'principalId',
        'sessionId',
        'sessionIssuedAtEpochMs',
        'sessionExpiresAtEpochMs',
        'requestId',
        'request',
        'capturedAtEpochMs',
        'policy',
        'serviceId'
    ], 'Matchmaking command');
    requireString(command.principalId, 'Matchmaking actor');
    requireString(command.sessionId, 'Matchmaking session');
    requireString(command.requestId, 'Matchmaking request');
    requireEpoch(command.sessionIssuedAtEpochMs, 'Matchmaking session issuance');
    requireEpoch(command.sessionExpiresAtEpochMs, 'Matchmaking session expiry');
    if (command.sessionExpiresAtEpochMs <= command.sessionIssuedAtEpochMs || command.requestId.length > 128) {
        throw new TypeError('Matchmaking command session or request identity is invalid');
    }
    if (command.serviceId !== null) {
        requireString(command.serviceId, 'Matchmaking capture service');
    }
    if (command.capturedAtEpochMs === null) {
        if (command.policy !== null || command.serviceId !== null) {
            throw new TypeError('Uncaptured matchmaking command cannot contain captured policy or service');
        }
    }
    else {
        requireEpoch(command.capturedAtEpochMs, 'Matchmaking capture time');
        requireString(command.serviceId, 'Matchmaking capture service');
        decodeMatchmakingPolicy(command.policy);
    }
    return {
        scope: decodeMatchmakingScope(command.scope),
        principalId: command.principalId,
        sessionId: command.sessionId,
        sessionIssuedAtEpochMs: command.sessionIssuedAtEpochMs,
        sessionExpiresAtEpochMs: command.sessionExpiresAtEpochMs,
        requestId: command.requestId,
        request: decodeMatchmakingRequest(command.request),
        capturedAtEpochMs: command.capturedAtEpochMs,
        policy: command.policy === null ? null : decodeMatchmakingPolicy(command.policy),
        serviceId: command.serviceId
    };
}

export function decodeMatchmakingResult(value: unknown, command: MatchmakingCommand): MatchmakingMutationResult {
    const result = decodeMatchmakingMutationResult(value);
    if (
        !isSameGroupScope(result.scope, command.scope) || result.principalId !== command.principalId ||
        result.requestId !== command.requestId ||
        (command.request.action !== 'start' && result.searchId !== command.request.searchId)
    ) {
        throw new TypeError('Matchmaking result differs from its retained command');
    }
    return result;
}
